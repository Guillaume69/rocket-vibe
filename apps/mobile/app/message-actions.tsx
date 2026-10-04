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

import { subscriptions, messages, rooms } from '../db/schema.ts';
import {
  actionsPossibles,
  messageGoneFromServer,
  rulesFromSettings,
  textToCopy,
  type ActionMessage,
  type MessageRules,
} from '../lib/messageActions.ts';
import {
  localQuoteAttachment,
  messagePermalink,
  firstAttachmentImage,
  stripQuotePrefix,
} from '../lib/quote.ts';
import { unicodeOfShortcode } from '../lib/emojis.ts';
import { attachmentToShare } from '../lib/attachment.ts';
import { starredBy, starredAfter } from '../lib/marks.ts';
import { ENCRYPTED_TYPE } from '../lib/normalize.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import { reactionList } from '../lib/reactions.ts';
import type { ClientRest } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { saveInBackground, shareInBackground } from '../ui/attachmentActions.ts';
import { useT } from '../ui/i18n.ts';
import { requestReply } from '../ui/reply.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

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
const reglesParServeur = new Map<string, MessageRules>();
async function lireRegles(client: ClientRest): Promise<MessageRules> {
  const enCache = reglesParServeur.get(client.baseUrl);
  if (enCache !== undefined) return enCache;
  try {
    const reponse = await client.get<{ settings?: { _id?: string; value?: unknown }[] }>(
      'settings.public',
      { params: { count: 0 } },
    );
    const regles = rulesFromSettings(reponse.settings ?? []);
    reglesParServeur.set(client.baseUrl, regles);
    return regles;
  } catch {
    return rulesFromSettings([]);
  }
}

type Charge = {
  message: {
    id: string;
    rid: string;
    /** `tmid` : la racine du fil si ce message en est déjà une réponse. */
    threadId: string | null;
    systemType: string | null;
    text: string | null;
    authorName: string | null;
    attachments: string | null;
    reactions: string | null;
    pinned: boolean;
    starred: string | null;
  };
  /** De quoi bâtir le permalien d'une citation (`lib/quote.ts`). */
  room: { type: string; name: string | null };
  actions: ActionMessage[];
};

export default function MessageActionsScreen() {
  // `fil` : présent quand la feuille est ouverte DEPUIS l'écran d'un fil — la
  // cible de réponse est alors adressée au composer de ce fil, pas du salon.
  const { id, thread: fil } = useLocalSearchParams<{ id: string; thread?: string }>();
  const { state: etat } = useSession();
  const synchro = useSync();
  const routeur = useRouter();
  const c = useColors();
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
  const moteur = synchro.phase === 'pret' ? synchro.engine : null;
  const actionneur = synchro.phase === 'pret' ? synchro.actions : null;
  const e2e = synchro.phase === 'pret' ? synchro.e2e : null;
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
      // Hors ligne ou refusées : `null`, les droits d'un simple membre.
      const promesseSources = sourcesPermissions(client).catch(() => null);
      const lignes = await base.select().from(messages).where(eq(messages.id, id)).limit(1);
      const brut = lignes[0];
      if (annule) return;
      if (brut === undefined) {
        // Supprimé entre l'appui long et l'ouverture (stream deleteMessage).
        setErreur(t('actionsMessage.messageIntrouvable'));
        return;
      }
      const [lignesSalon, lignesAbonnement, regles, sources] = await Promise.all([
        base.select().from(rooms).where(eq(rooms.rid, brut.rid)).limit(1),
        base
          .select({ roles: subscriptions.roles })
          .from(subscriptions)
          .where(eq(subscriptions.rid, brut.rid))
          .limit(1),
        promesseRegles,
        promesseSources,
      ]);
      if (annule) return;
      setCharge({
        message: {
          id: brut.id,
          rid: brut.rid,
          threadId: brut.threadId,
          systemType: brut.systemType,
          text: brut.text,
          authorName: brut.authorName,
          attachments: brut.attachments,
          reactions: brut.reactions,
          pinned: brut.pinned,
          starred: brut.starred,
        },
        // Ligne de salon absente (lien profond avant synchro) : repli `c`/rid —
        // le serveur ne lit de toute façon que le `?msg=` du permalien.
        room: { type: lignesSalon[0]?.type ?? 'c', name: lignesSalon[0]?.name ?? null },
        actions: actionsPossibles({
          message: {
            authorId: brut.authorId,
            ts: brut.ts,
            systemType: brut.systemType,
            text: brut.text,
            attachments: brut.attachments,
            pinned: brut.pinned,
            starred: starredBy(brut.starred, moi),
          },
          me: moi,
          rules: regles,
          permissions:
            sources === null
              ? null
              : grantedPermissions(sources, roomRoles(lignesAbonnement[0]?.roles)),
          readOnly: lignesSalon[0]?.readOnly === true,
          encrypted: lignesSalon[0]?.encrypted === true,
          inThread: typeof fil === 'string',
          now: Date.now(),
        }),
      });
    })().catch(() => {
      if (!annule) setErreur(t('actionsMessage.chargementImpossible'));
    });
    return () => {
      annule = true;
    };
  }, [pret, id, fil, base, client, moi, t]);

  // Mes réactions déjà posées sur ce message : contour accentué, et le tap
  // RETIRE au lieu d'ajouter — `chat.react` sait faire les deux, le câblage en
  // dur à `mettre: true` rendait toute réaction inannulable.
  const mesReactions = useMemo(
    () =>
      new Set(
        reactionList(charge?.message.reactions ?? null, monUsername)
          .filter((r) => r.byMe)
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
      <View style={[styles.sheet, styles.center, { paddingBottom: bas }]}>
        {erreur !== null ? (
          <Text style={[styles.error, { color: c.errorText }]}>{erreur}</Text>
        ) : (
          <ActivityIndicator color={c.accent} />
        )}
      </View>
    );
  }
  const { message, room: salon, actions } = charge;
  const enEdition = edition !== null;

  // Arme la cible de réponse pour le composer d'origine (salon ou fil) puis se
  // referme — l'envoi lui-même se joue là-bas, avec le texte tapé ensuite.
  const repondre = () => {
    void Haptics.selectionAsync();
    const permalien = messagePermalink({
      baseUrl: client.baseUrl,
      siteUrl,
      type: salon.type,
      name: salon.name,
      rid: message.rid,
      msgId: message.id,
    });
    requestReply(typeof fil === 'string' ? `${message.rid}:${fil}` : message.rid, {
      id: message.id,
      author: message.authorName,
      preview: stripQuotePrefix(message.text ?? '').trim() || null,
      permalink: permalien,
      localAttachment: localQuoteAttachment({
        permalink: permalien,
        author: message.authorName,
        text: message.text,
        attachments: message.attachments,
      }),
      previewImage: firstAttachmentImage(message.attachments),
    });
    routeur.back();
  };

  // Un fichier joint part COMME fichier ; sinon le texte. La légende d'une
  // image reste à « Copier ». Le fichier se télécharge EN FOND : la feuille se
  // referme tout de suite, la progression s'affiche sur le message.
  const jointe = attachmentToShare(message.attachments);
  const aTransferer =
    jointe === null
      ? null
      : {
          key: jointe.path,
          url: protectedFileUrl(client, jointe.path),
          title: jointe.title,
          type: jointe.type,
          size: jointe.size,
          encryption: jointe.encryption,
        };
  const partager = async () => {
    if (aTransferer === null) {
      await Share.share({ message: textToCopy(message.text) ?? '' });
      return;
    }
    shareInBackground(aTransferer, t);
  };
  const enregistrer = async () => {
    if (aTransferer !== null) saveInBackground(aTransferer, t);
  };

  // Le serveur ne rediffuse pas toujours le message marqué (voir
  // `lib/marks.ts`) : l'état local se pose ici, après le succès.
  const epingler = async (mettre: boolean) => {
    if (mettre) await actionneur.pin(message.rid, message.id);
    else await actionneur.unpin(message.rid, message.id);
    await moteur.syncStore.updateMessageMarks(message.id, mettre, message.starred);
  };
  const etoiler = async (mettre: boolean) => {
    await actionneur.star(message.rid, message.id, mettre);
    if (moi === null) return;
    await moteur.syncStore.updateMessageMarks(
      message.id,
      message.pinned,
      starredAfter(message.starred, moi, mettre),
    );
  };

  return (
    <View style={[styles.sheet, { maxHeight: hauteurMax, paddingBottom: bas }]}>
      {!enEdition && actions.includes('reagir') && (
        <View style={styles.rangeeEmojis}>
          {CODES_REACTION.map((code) => {
            const dejaPosee = mesReactions.has(code);
            return (
              <Tappable
                key={code}
                disabled={occupe}
                android_ripple={{ color: c.ripple, borderless: true }}
                unstable_pressDelay={LIST_PRESS_DELAY}
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
                  void agir(() => actionneur.react(message.rid, message.id, code, !dejaPosee))
                }
              >
                <Text style={styles.emoji}>{unicodeOfShortcode(code) ?? `:${code}:`}</Text>
              </Tappable>
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
            placeholderTextColor={c.tertiaryText}
            style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          />
          <View style={styles.rangeeEdition}>
            <Pressable
              disabled={occupe}
              onPress={() => setEdition(null)}
              style={({ pressed }) => [styles.boutonSecondaire, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.boutonSecondaireTexte, { color: c.dimmed }]}>{t('commun.annuler')}</Text>
            </Pressable>
            <Pressable
              disabled={occupe}
              onPress={() =>
                void agir(() =>
                  actionneur.edit(
                    message.rid,
                    message.id,
                    edition ?? '',
                    message.systemType === ENCRYPTED_TYPE ? (e2e ?? undefined) : undefined,
                  ),
                )
              }
              style={({ pressed }) => [
                styles.boutonPrincipal,
                { backgroundColor: c.accent, opacity: pressed || occupe ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.boutonPrincipalTexte, { color: c.onAccent }]}>{t('commun.enregistrer')}</Text>
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
            <Text style={[styles.aucuneAction, { color: c.dimmed }]}>
              {t('actionsMessage.aucuneAction')}
            </Text>
          )}
          {actions.includes('repondre') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="↩️"
              label={t('actionsMessage.repondre')}
              onPress={repondre}
            />
          )}
          {actions.includes('repondreFil') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="🧵"
              label={t('actionsMessage.repondreFil')}
              onPress={() => {
                void Haptics.selectionAsync();
                routeur.back();
                routeur.push({ pathname: '/thread/[id]', params: { id: message.threadId ?? message.id } });
              }}
            />
          )}
          {actions.includes('copier') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="📋"
              label={t('actionsMessage.copier')}
              onPress={() => void agir(() => Clipboard.setStringAsync(textToCopy(message.text) ?? ''))}
            />
          )}
          {actions.includes('partager') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="📤"
              label={t('actionsMessage.partager')}
              onPress={() => void agir(partager)}
            />
          )}
          {actions.includes('enregistrer') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="⬇️"
              label={t('actionsMessage.enregistrer')}
              onPress={() => void agir(enregistrer)}
            />
          )}
          {actions.includes('modifier') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="✏️"
              label={t('actionsMessage.modifier')}
              onPress={() => {
                void Haptics.selectionAsync();
                setEdition(message.text ?? '');
              }}
            />
          )}
          {actions.includes('epingler') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="📌"
              label={t('actionsMessage.epingler')}
              onPress={() => void agir(() => epingler(true))}
            />
          )}
          {actions.includes('desepingler') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="📌"
              label={t('actionsMessage.desepingler')}
              onPress={() => void agir(() => epingler(false))}
            />
          )}
          {actions.includes('etoiler') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="⭐"
              label={t('actionsMessage.etoiler')}
              onPress={() => void agir(() => etoiler(true))}
            />
          )}
          {actions.includes('desetoiler') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="⭐"
              label={t('actionsMessage.desetoiler')}
              onPress={() => void agir(() => etoiler(false))}
            />
          )}
          {actions.includes('supprimer') && (
            <ActionLigne
              c={c}
              disabled={occupe}
              icon="🗑"
              label={t('commun.supprimer')}
              destructive
              onPress={() =>
                void agir(async () => {
                  try {
                    await actionneur.delete(message.rid, message.id);
                    // La ligne locale tombera par le stream `deleteMessage`.
                  } catch (e) {
                    // Fantôme : déjà supprimé d'un AUTRE client pendant que
                    // l'app était fermée — le serveur ne le connaît plus,
                    // seule la ligne locale reste. La purger EST la
                    // suppression demandée ; toute autre erreur reste fatale.
                    if (!(await messageGoneFromServer(client, message.id))) throw e;
                    await moteur.syncStore.deleteMessage(message.id);
                  }
                })
              }
            />
          )}
        </View>
      )}

      {erreur !== null && (
        <Text style={[styles.error, { color: c.errorText }]}>{erreur}</Text>
      )}
    </View>
  );
}

/** Une ligne d'action pleine largeur : icône + libellé, ondulation Android. */
function ActionLigne({
  c,
  icon: icone,
  label: libelle,
  onPress,
  disabled,
  destructive: destructif = false,
}: {
  c: ReturnType<typeof useColors>;
  icon: string;
  label: string;
  onPress: () => void;
  disabled: boolean;
  destructive?: boolean;
}) {
  return (
    // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
    // doux : le masque du ripple borné ignore borderRadius sous Fabric.
    <View style={styles.rowWrapper}>
      <Tappable
        disabled={disabled}
        onPress={onPress}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={styles.rowIcon}>{icone}</Text>
        <Text style={[styles.rowText, { color: destructif ? c.errorText : c.text }]}>
          {libelle}
        </Text>
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
  sheet: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  center: { minHeight: 96, alignItems: 'center', justifyContent: 'center' },
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
    fontFamily: FONTS.body,
    fontSize: 13.5,
    textAlign: 'center',
    paddingVertical: 14,
  },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  rowIcon: { fontSize: 19, width: 24, textAlign: 'center' },
  rowText: { fontFamily: FONTS.corpsGras, fontSize: 15.5 },
  blocEdition: { gap: 12 },
  field: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    fontFamily: FONTS.body,
    fontSize: 15,
    minHeight: 80,
    // Plafond du champ : au-delà, il défile en interne (la sheet ne s'emballe pas).
    maxHeight: 200,
  },
  rangeeEdition: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  boutonSecondaire: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  boutonSecondaireTexte: { fontFamily: FONTS.corpsGras, fontSize: 15 },
  boutonPrincipal: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  boutonPrincipalTexte: { fontFamily: FONTS.title, fontSize: 15 },
  error: { fontFamily: FONTS.body, fontSize: 13, paddingTop: 8 },
});
