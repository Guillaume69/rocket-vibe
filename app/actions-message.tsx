import { eq } from 'drizzle-orm';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { messages, salons } from '../db/schema.ts';
import {
  actionsPossibles,
  messageDisparuDuServeur,
  reglesDepuisReglages,
  texteACopier,
  type ActionMessage,
  type ReglesMessages,
} from '../lib/actionsMessage.ts';
import {
  jointeCitationLocale,
  permalienMessage,
  premiereImageDesJointes,
  sansPrefixeCitation,
} from '../lib/citation.ts';
import { unicodeDeCodeCourt } from '../lib/emojis.ts';
import { listeReactions } from '../lib/reactions.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useT } from '../ui/i18n.ts';
import { demanderReponse } from '../ui/reponse.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

/**
 * Feuille d'actions d'un message (8.2) — `presentation: 'formSheet'` déclarée
 * dans `app/_layout.tsx` : le bottom sheet NATIF de react-native-screens
 * (contrainte : pas de @gorhom/bottom-sheet). La sheet épouse la hauteur de son
 * contenu (`sheetAllowedDetents: 'fitToContents'`), PLAFONNÉE à 80 % de l'écran
 * ici (`maxHeight`) — au-delà, le champ d'édition défile en interne. La décision
 * d'affichage vient de la fonction pure `actionsPossibles` ; le serveur reste
 * l'autorité en cas de refus.
 */

// `chat.react` refuse l'unicode brut (« Invalid emoji provided ») : il veut le
// SHORTNAME Rocket.Chat. On envoie le code, on affiche le glyphe que la table
// en tire — une seule source de vérité, la même qui rend les messages.
const CODES_REACTION = ['+1', 'heart', 'joy', 'tada', 'open_mouth', 'pray'];

/**
 * Réglages messages : une lecture par SERVEUR (clef `baseUrl` — un cache
 * global survivrait à un changement de serveur et appliquerait les règles de
 * l'ancien au nouveau). L'échec n'est jamais mémoïsé : hors ligne, on retombe
 * sur des règles permissives le temps de l'ouverture — le serveur tranchera.
 */
const reglesParServeur = new Map<string, ReglesMessages>();
async function lireRegles(client: ClientRest): Promise<ReglesMessages> {
  const enCache = reglesParServeur.get(client.baseUrl);
  if (enCache !== undefined) return enCache;
  try {
    const reponse = await client.get<{ settings?: { _id?: string; value?: unknown }[] }>(
      'settings.public',
      { params: { count: 0 } },
    );
    const regles = reglesDepuisReglages(reponse.settings ?? []);
    reglesParServeur.set(client.baseUrl, regles);
    return regles;
  } catch {
    return reglesDepuisReglages([]);
  }
}

type Charge = {
  message: {
    id: string;
    rid: string;
    texte: string | null;
    auteurNom: string | null;
    piecesJointes: string | null;
    reactions: string | null;
  };
  /** De quoi bâtir le permalien d'une citation (`lib/citation.ts`). */
  salon: { type: string; nom: string | null };
  actions: ActionMessage[];
};

export default function EcranActionsMessage() {
  // `fil` : présent quand la feuille est ouverte DEPUIS l'écran d'un fil — la
  // cible de réponse est alors adressée au composer de ce fil, pas du salon.
  const { id, fil } = useLocalSearchParams<{ id: string; fil?: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const routeur = useRouter();
  const c = useCouleurs();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Plafond de la sheet : au-delà, le contenu (le champ d'édition) défile.
  const hauteurMax = Math.round(height * 0.8);
  // Marge basse : sous la barre de gestes, plus une respiration.
  const bas = insets.bottom + 12;

  // Message et actions calculées naissent du même chargement : UN état, pour
  // qu'ils ne puissent pas se désynchroniser.
  const [charge, setCharge] = useState<Charge | null>(null);
  const [edition, setEdition] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const pret = synchro.phase === 'pret' && etat.phase === 'connecte' && typeof id === 'string';
  const base = synchro.phase === 'pret' ? synchro.base : null;
  const moteur = synchro.phase === 'pret' ? synchro.moteur : null;
  const actionneur = synchro.phase === 'pret' ? synchro.actions : null;
  const client = etat.phase === 'connecte' ? etat.client : null;
  const moi = etat.phase === 'connecte' ? etat.session.userId : null;
  const siteUrl = etat.phase === 'connecte' ? etat.session.siteUrl : null;
  // Les réactions se jugent au USERNAME (le serveur ne stocke que les pseudos),
  // là où `actionsPossibles` raisonne par uid — les deux identités servent.
  const monUsername = etat.phase === 'connecte' ? etat.session.username : null;

  useEffect(() => {
    if (!pret || base === null || client === null || moi === null) return;
    let annule = false;
    (async () => {
      // Les règles ne dépendent de rien de local : la requête part tout de
      // suite, en parallèle des lectures SQLite.
      const promesseRegles = lireRegles(client);
      const lignes = await base.select().from(messages).where(eq(messages.id, id)).limit(1);
      const brut = lignes[0];
      if (annule) return;
      if (brut === undefined) {
        // Supprimé entre l'appui long et l'ouverture (stream deleteMessage).
        setErreur(t('actionsMessage.messageIntrouvable'));
        return;
      }
      const [lignesSalon, regles] = await Promise.all([
        base.select().from(salons).where(eq(salons.rid, brut.rid)).limit(1),
        promesseRegles,
      ]);
      if (annule) return;
      setCharge({
        message: {
          id: brut.id,
          rid: brut.rid,
          texte: brut.texte,
          auteurNom: brut.auteurNom,
          piecesJointes: brut.piecesJointes,
          reactions: brut.reactions,
        },
        // Ligne de salon absente (lien profond avant synchro) : repli `c`/rid —
        // le serveur ne lit de toute façon que le `?msg=` du permalien.
        salon: { type: lignesSalon[0]?.type ?? 'c', nom: lignesSalon[0]?.nom ?? null },
        actions: actionsPossibles({
          message: {
            auteurId: brut.auteurId,
            horodatage: brut.horodatage,
            typeSysteme: brut.typeSysteme,
            texte: brut.texte,
          },
          moi,
          regles,
          permissions: [],
          lectureSeule: lignesSalon[0]?.lectureSeule === true,
          chiffre: lignesSalon[0]?.chiffre === true,
          maintenant: Date.now(),
        }),
      });
    })().catch(() => {
      if (!annule) setErreur(t('actionsMessage.chargementImpossible'));
    });
    return () => {
      annule = true;
    };
  }, [pret, id, base, client, moi, t]);

  // Mes réactions déjà posées sur ce message : contour accentué, et le tap
  // RETIRE au lieu d'ajouter — `chat.react` sait faire les deux, le câblage en
  // dur à `mettre: true` rendait toute réaction inannulable.
  const mesReactions = useMemo(
    () =>
      new Set(
        listeReactions(charge?.message.reactions ?? null, monUsername)
          .filter((r) => r.parMoi)
          .map((r) => r.code),
      ),
    [charge, monUsername],
  );

  // Garde de réentrance dans une ref : l'état React d'un rendu passé
  // laisserait un double-tap déclencher l'action deux fois — et deux
  // `routeur.back()`, dont le second éjecte du salon.
  const enVol = useRef(false);
  const agir = useCallback(
    async (action: () => Promise<unknown>) => {
      if (enVol.current) return;
      enVol.current = true;
      // Tick de sélection à la confirmation de l'action (réaction, épingler,
      // supprimer, enregistrer) — retour haptique léger.
      void Haptics.selectionAsync();
      setOccupe(true);
      setErreur(null);
      try {
        await action();
        routeur.back();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : t('actionsMessage.actionRefusee'));
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [routeur, t],
  );

  if (!pret || client === null || moteur === null || actionneur === null || charge === null) {
    return (
      <View style={[styles.feuille, styles.centre, { paddingBottom: bas }]}>
        {erreur !== null ? (
          <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
        ) : (
          <ActivityIndicator color={c.accent} />
        )}
      </View>
    );
  }
  const { message, salon, actions } = charge;
  const enEdition = edition !== null;

  // Arme la cible de réponse pour le composer d'origine (salon ou fil) puis se
  // referme — l'envoi lui-même se joue là-bas, avec le texte tapé ensuite.
  const repondre = () => {
    void Haptics.selectionAsync();
    const permalien = permalienMessage({
      baseUrl: client.baseUrl,
      siteUrl,
      type: salon.type,
      nom: salon.nom,
      rid: message.rid,
      msgId: message.id,
    });
    demanderReponse(typeof fil === 'string' ? `${message.rid}:${fil}` : message.rid, {
      id: message.id,
      auteur: message.auteurNom,
      apercu: sansPrefixeCitation(message.texte ?? '').trim() || null,
      permalien,
      jointeLocale: jointeCitationLocale({
        permalien,
        auteur: message.auteurNom,
        texte: message.texte,
        piecesJointes: message.piecesJointes,
      }),
      imageApercu: premiereImageDesJointes(message.piecesJointes),
    });
    routeur.back();
  };

  return (
    <View style={[styles.feuille, { maxHeight: hauteurMax, paddingBottom: bas }]}>
      {!enEdition && actions.includes('reagir') && (
        <View style={styles.rangeeEmojis}>
          {CODES_REACTION.map((code) => {
            const dejaPosee = mesReactions.has(code);
            return (
              <Pressable
                key={code}
                disabled={occupe}
                android_ripple={{ color: c.ondulation, borderless: true }}
                unstable_pressDelay={DELAI_PRESSION_LISTE}
                accessibilityState={{ selected: dejaPosee }}
                style={({ pressed }) => [
                  styles.pastilleEmoji,
                  {
                    backgroundColor: c.surfaceActive,
                    opacity: pressed ? 0.6 : 1,
                    // Toujours une bordure (transparente au repos) : son
                    // apparition ne doit pas faire bouger la rangée d'un pixel.
                    borderColor: dejaPosee ? c.accent : 'transparent',
                  },
                ]}
                onPress={() =>
                  void agir(() => actionneur.reagir(message.rid, message.id, code, !dejaPosee))
                }
              >
                <Text style={styles.emoji}>{unicodeDeCodeCourt(code) ?? `:${code}:`}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {enEdition ? (
        <View style={styles.blocEdition}>
          <TextInput
            value={edition}
            onChangeText={setEdition}
            multiline
            autoFocus
            placeholderTextColor={c.texteTertiaire}
            style={[styles.champ, { color: c.texte, backgroundColor: c.carte, borderColor: c.bordure }]}
          />
          <View style={styles.rangeeEdition}>
            <Pressable
              disabled={occupe}
              onPress={() => setEdition(null)}
              style={({ pressed }) => [styles.boutonSecondaire, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.boutonSecondaireTexte, { color: c.attenue }]}>{t('commun.annuler')}</Text>
            </Pressable>
            <Pressable
              disabled={occupe}
              onPress={() =>
                void agir(() => actionneur.modifier(message.rid, message.id, edition ?? ''))
              }
              style={({ pressed }) => [
                styles.boutonPrincipal,
                { backgroundColor: c.accent, opacity: pressed || occupe ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.boutonPrincipalTexte, { color: c.surAccent }]}>{t('commun.enregistrer')}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.listeActions}>
          {/* Aucune action possible (message système : arrivée, départ,
              renommage) : le dire. Sans ce repli la feuille montait sur une
              bande de 30 px sans un mot, et l'appui long avait vibré pour
              rien — l'utilisateur croit à un bug d'affichage. */}
          {actions.length === 0 && (
            <Text style={[styles.aucuneAction, { color: c.attenue }]}>
              {t('actionsMessage.aucuneAction')}
            </Text>
          )}
          {actions.includes('repondre') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="↩️"
              libelle={t('actionsMessage.repondre')}
              onPress={repondre}
            />
          )}
          {actions.includes('copier') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="📋"
              libelle={t('actionsMessage.copier')}
              onPress={() => void agir(() => Clipboard.setStringAsync(texteACopier(message.texte) ?? ''))}
            />
          )}
          {actions.includes('partager') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="📤"
              libelle={t('actionsMessage.partager')}
              onPress={() => void agir(() => Share.share({ message: texteACopier(message.texte) ?? '' }))}
            />
          )}
          {actions.includes('modifier') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="✏️"
              libelle={t('actionsMessage.modifier')}
              onPress={() => {
                void Haptics.selectionAsync();
                setEdition(message.texte ?? '');
              }}
            />
          )}
          {actions.includes('epingler') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="📌"
              libelle={t('actionsMessage.epingler')}
              onPress={() => void agir(() => actionneur.epingler(message.rid, message.id))}
            />
          )}
          {actions.includes('supprimer') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icone="🗑"
              libelle={t('commun.supprimer')}
              destructif
              onPress={() =>
                void agir(async () => {
                  try {
                    await actionneur.supprimer(message.rid, message.id);
                    // La ligne locale tombera par le stream `deleteMessage`.
                  } catch (e) {
                    // Fantôme : déjà supprimé d'un AUTRE client pendant que
                    // l'app était fermée — le serveur ne le connaît plus,
                    // seule la ligne locale reste. La purger EST la
                    // suppression demandée ; toute autre erreur reste fatale.
                    if (!(await messageDisparuDuServeur(client, message.id))) throw e;
                    await moteur.depotSynchro.supprimerMessage(message.id);
                  }
                })
              }
            />
          )}
        </View>
      )}

      {erreur !== null && (
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
      )}
    </View>
  );
}

/** Une ligne d'action pleine largeur : icône + libellé, ondulation Android. */
function ActionLigne({
  c,
  icone,
  libelle,
  onPress,
  disabled,
  destructif = false,
}: {
  c: ReturnType<typeof useCouleurs>;
  icone: string;
  libelle: string;
  onPress: () => void;
  disabled: boolean;
  destructif?: boolean;
}) {
  return (
    // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
    // doux : le masque du ripple borné ignore borderRadius sous Fabric.
    <View style={styles.enveloppeLigne}>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={styles.ligneIcone}>{icone}</Text>
        <Text style={[styles.ligneTexte, { color: destructif ? c.texteErreur : c.texte }]}>
          {libelle}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
  feuille: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  centre: { minHeight: 96, alignItems: 'center', justifyContent: 'center' },
  rangeeEmojis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingBottom: 10,
  },
  pastilleEmoji: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 26 },
  listeActions: { gap: 2 },
  aucuneAction: {
    fontFamily: POLICES.corps,
    fontSize: 13.5,
    textAlign: 'center',
    paddingVertical: 14,
  },
  enveloppeLigne: { borderRadius: 12, overflow: 'hidden' },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  ligneIcone: { fontSize: 19, width: 24, textAlign: 'center' },
  ligneTexte: { fontFamily: POLICES.corpsGras, fontSize: 15.5 },
  blocEdition: { gap: 12 },
  champ: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    fontFamily: POLICES.corps,
    fontSize: 15,
    minHeight: 80,
    // Plafond du champ : au-delà, il défile en interne (la sheet ne s'emballe pas).
    maxHeight: 200,
  },
  rangeeEdition: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  boutonSecondaire: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  boutonSecondaireTexte: { fontFamily: POLICES.corpsGras, fontSize: 15 },
  boutonPrincipal: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  boutonPrincipalTexte: { fontFamily: POLICES.titre, fontSize: 15 },
  erreur: { fontFamily: POLICES.corps, fontSize: 13, paddingTop: 8 },
});
