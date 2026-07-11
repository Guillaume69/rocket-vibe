/**
 * Ligne de message, partagée entre l'écran salon et l'écran fil (8.3).
 *
 * Extraite de `app/salon/[rid].tsx` : l'écran fil affiche exactement les
 * mêmes lignes (markdown, messages système, pièces jointes protégées,
 * statuts d'envoi) — la dupliquer aurait fait diverger les deux rendus.
 */

import { memo, useMemo } from 'react';
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { messages } from '../db/schema.ts';
import { arbreDuMessage } from '../lib/markdown.ts';
import { texteSysteme } from '../lib/messagesSysteme.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar, urlFichierProtege } from '../lib/upload.ts';
import { TuileAvatar } from './kit.tsx';
import { CorpsMessage, GardeRendu } from './markdown.tsx';
import { type Couleurs, degradeAvatar, POLICES } from './theme.ts';
import { useVisionneuse } from './visionneuse.tsx';

export type LigneDeMessage = typeof messages.$inferSelect;

export const LigneMessage = memo(function LigneMessage({
  c,
  message,
  client,
  statutEnvoi,
  surReessayer,
  surAbandonner,
  surAppuiLong,
  surOuvrirFil,
}: {
  c: Couleurs;
  message: LigneDeMessage;
  client: ClientRest;
  statutEnvoi: 'en-attente' | 'echec' | null;
  surReessayer: (() => void) | null;
  surAbandonner: ((id: string) => void) | null;
  surAppuiLong: ((id: string) => void) | null;
  /** Ouvre l'écran du fil. `null` dans l'écran fil lui-même. */
  surOuvrirFil: ((id: string) => void) | null;
}) {
  const heure = new Date(message.horodatage).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const appuiLong = surAppuiLong === null ? undefined : () => surAppuiLong(message.id);
  const auteur = message.auteurNom ?? '?';
  // Le pseudo prend la première teinte de sa propre tuile-avatar : nom et
  // avatar s'accordent, la même personne garde sa couleur d'un message à l'autre.
  const teinteAuteur = degradeAvatar(auteur, c.avatarsDegrades)[0];

  return (
    <Pressable
      onLongPress={appuiLong}
      delayLongPress={350}
      // Sans quoi le Pressable fusionne la ligne en UN nœud d'accessibilité :
      // TalkBack ne peut plus atteindre « réessayer », « abandonner » ni les
      // pièces jointes individuellement.
      accessible={false}
      style={[styles.message, statutEnvoi === 'en-attente' && styles.enAttente]}
    >
      {/* La ligne est `accessible={false}` pour que TalkBack atteigne
          réessayer/abandonner/pièces jointes ; l'initiale décorative ne doit
          pas devenir un nœud de plus, elle double la navigation au balayage. */}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <TuileAvatar
          c={c}
          cle={auteur}
          initiale={auteur.charAt(0) || '?'}
          uri={urlAvatar(client, { uid: message.auteurId })}
          taille={34}
          rayon={12}
        />
      </View>
      <View style={styles.corps}>
        <View style={styles.enTete}>
          <Text style={[styles.auteur, { color: teinteAuteur }]} numberOfLines={1}>
            {auteur}
          </Text>
          <Text style={[styles.heure, { color: c.texteTertiaire }]}>{heure}</Text>
          {message.modifieLe !== null && (
            <Text style={[styles.heure, { color: c.texteTertiaire }]}>(modifié)</Text>
          )}
          {statutEnvoi === 'en-attente' && (
            <Text style={[styles.heure, { color: c.texteTertiaire }]}>⏳ envoi…</Text>
          )}
        </View>
        <ContenuMessage c={c} message={message} />
        {message.piecesJointes !== null && (
          <PiecesJointes
            c={c}
            brut={message.piecesJointes}
            client={client}
            surAppuiLong={appuiLong}
          />
        )}
        {surOuvrirFil !== null && message.filReponses > 0 && (
          <Pressable
            onPress={() => surOuvrirFil(message.id)}
            style={[styles.puceFil, { backgroundColor: c.carte, borderColor: c.bordure }]}
          >
            <Text style={[styles.puceFilTexte, { color: c.cyan }]}>
              💬 {message.filReponses} {message.filReponses === 1 ? 'réponse' : 'réponses'}
              {message.filDernier !== null &&
                ` · ${new Date(message.filDernier).toLocaleTimeString('fr-FR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`}
            </Text>
          </Pressable>
        )}
        {statutEnvoi === 'echec' && (
          <View style={styles.actionsEchec}>
            <Pressable onPress={surReessayer ?? undefined}>
              <Text style={[styles.heure, { color: c.texteErreur }]}>⚠️ Échec — réessayer</Text>
            </Pressable>
            <Pressable onPress={() => surAbandonner?.(message.id)}>
              <Text style={[styles.heure, { color: c.attenue }]}>abandonner</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Pressable>
  );
});

/**
 * Corps d'un message : markdown pour les messages ordinaires (`md` du serveur,
 * ou `parse()` local pour les VIEUX messages qui n'en ont pas — repli imposé
 * par le contrat 4.3), substitut sobre pour le chiffré et les messages
 * système (leur traduction arrive en 4.4).
 */
function ContenuMessage({ c, message }: { c: Couleurs; message: LigneDeMessage }) {
  // Clés = les CHAÎNES, stables à travers le barattage d'objets de
  // `useLiveQuery` (qui défait le memo de LigneMessage) : sans cela, chaque
  // écriture en base re-parserait le markdown de toutes les lignes visibles.
  const arbre = useMemo(
    () => (message.typeSysteme === null ? arbreDuMessage(message.md, message.texte) : null),
    [message.typeSysteme, message.md, message.texte],
  );

  if (message.typeSysteme === 'e2e') {
    return <Substitut c={c} texte="🔒 Message chiffré, non pris en charge" />;
  }
  if (message.typeSysteme !== null) {
    // La phrase suit le nom de l'auteur affiché juste au-dessus : « bob a
    // rejoint le salon ». `texte` porte le PARAMÈTRE de l'action, pas une
    // phrase — voir lib/messagesSysteme.ts.
    return <Substitut c={c} texte={texteSysteme(message.typeSysteme, message.texte)} />;
  }
  if (arbre === null) {
    // Un message d'upload n'a souvent NI texte NI md : ses pièces jointes,
    // rendues à côté, sont tout son contenu — rien à substituer.
    if (message.piecesJointes !== null) return null;
    return <Substitut c={c} texte="(message vide)" />;
  }
  return (
    // Le `md` est en dernier ressort une donnée d'autrui : une forme qui
    // échappe aux validations ne doit coûter que ce message, pas l'écran.
    <GardeRendu repli={<Text style={[styles.texte, { color: c.texte }]}>{message.texte}</Text>}>
      <CorpsMessage arbre={arbre} c={c} />
    </GardeRendu>
  );
}

function Substitut({ c, texte }: { c: Couleurs; texte: string }) {
  return <Text style={[styles.texte, styles.italique, { color: c.attenue }]}>{texte}</Text>;
}

type PieceJointe = {
  title?: string;
  title_link?: string;
  image_url?: string;
  audio_url?: string;
  image_dimensions?: { width?: number; height?: number };
};

/**
 * Pièces jointes (7.4) : `FileUpload_ProtectFiles = true` sur le serveur
 * cible — chaque URL de fichier reçoit `rc_uid`/`rc_token` en query, sinon
 * le serveur répond 403 et l'image reste blanche.
 *
 * `surAppuiLong` est transmis à chaque élément tapable : un toucher qui
 * démarre sur un enfant Pressable ne remonte jamais au Pressable de la ligne,
 * et un message d'upload (sans texte) n'offrirait AUCUNE surface pour la
 * feuille d'actions.
 */
function PiecesJointes({
  c,
  brut,
  client,
  surAppuiLong,
}: {
  c: Couleurs;
  brut: string;
  client: ClientRest;
  surAppuiLong: (() => void) | undefined;
}) {
  const { width: largeurEcran } = useWindowDimensions();
  const visionneuse = useVisionneuse();
  const jointes = useMemo<PieceJointe[]>(() => {
    try {
      const liste = JSON.parse(brut) as unknown;
      return Array.isArray(liste) ? (liste as PieceJointe[]) : [];
    } catch {
      return [];
    }
  }, [brut]);

  // Largeur disponible pour le corps : écran − marges de liste (16×2) −
  // colonne avatar (34) − gouttière (10), plafonnée pour les grands écrans.
  const dispoLargeur = Math.min(largeurEcran - 92, 380);

  return (
    <View style={styles.jointes}>
      {jointes.map((jointe, i) => {
        if (typeof jointe?.image_url === 'string') {
          // Rocket.Chat génère une VIGNETTE ~480 px (`image_url`) et conserve
          // l'ORIGINAL pleine résolution dans `title_link`. Afficher la
          // vignette la rendait pixelisée dès qu'on l'agrandissait : on prend
          // donc l'original, en le laissant se sous-échantillonner à la taille
          // d'affichage. Repli sur `image_url` si le serveur ne génère pas de
          // vignette (l'original EST alors `image_url`).
          const source =
            typeof jointe.title_link === 'string' ? jointe.title_link : jointe.image_url;
          const url = urlFichierProtege(client, source);
          // `image_dimensions` décrit la vignette, mais son RATIO est celui de
          // l'original — parfait pour le gabarit. La borne « pas d'upscale »
          // reste juste : min(480, dispo) = dispo, on remplit donc la largeur.
          const reelLargeur = jointe.image_dimensions?.width ?? null;
          const reelHauteur = jointe.image_dimensions?.height ?? null;
          const largeur = Math.max(Math.min(reelLargeur ?? dispoLargeur, dispoLargeur), 120);
          const ratio = (reelHauteur ?? largeur) / Math.max(reelLargeur ?? largeur, 1);
          // Un portrait très haut est plafonné (et recadré par `cover`) : la
          // vue en grand, au toucher, montre l'image entière.
          const hauteur = Math.min(Math.round(largeur * ratio), 400);
          return (
            <Pressable
              key={i}
              onPress={() =>
                visionneuse.ouvrir({
                  uri: url,
                  largeur: reelLargeur,
                  hauteur: reelHauteur,
                  titre: jointe.title ?? null,
                })
              }
              onLongPress={surAppuiLong}
              delayLongPress={350}
              accessibilityRole="imagebutton"
              accessibilityLabel={jointe.title ?? 'Image, toucher pour agrandir'}
            >
              <Image
                source={{ uri: url }}
                style={[styles.imageJointe, { width: largeur, height: hauteur }]}
                resizeMode="cover"
              />
            </Pressable>
          );
        }
        if (typeof jointe?.audio_url === 'string') {
          const url = urlFichierProtege(client, jointe.audio_url);
          return (
            <Pressable
              key={i}
              onPress={() => void Linking.openURL(url).catch(() => {})}
              onLongPress={surAppuiLong}
              delayLongPress={350}
            >
              <Text style={[styles.texte, { color: c.accent }]}>
                🎵 {jointe.title ?? 'Message vocal'}
              </Text>
            </Pressable>
          );
        }
        if (typeof jointe?.title_link === 'string') {
          const url = urlFichierProtege(client, jointe.title_link);
          return (
            <Pressable
              key={i}
              onPress={() => void Linking.openURL(url).catch(() => {})}
              onLongPress={surAppuiLong}
              delayLongPress={350}
            >
              <Text style={[styles.texte, { color: c.accent }]}>
                📄 {jointe.title ?? 'Fichier'}
              </Text>
            </Pressable>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  message: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  corps: { flex: 1, gap: 2 },
  enAttente: { opacity: 0.55 },
  enTete: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  auteur: { fontFamily: POLICES.corpsFort, fontSize: 13.5, flexShrink: 1 },
  heure: { fontFamily: POLICES.corps, fontSize: 10.5 },
  texte: { fontFamily: POLICES.corps, fontSize: 14, lineHeight: 20 },
  italique: { fontStyle: 'italic' },
  actionsEchec: { flexDirection: 'row', gap: 16 },
  jointes: { gap: 6, marginTop: 4 },
  imageJointe: { borderRadius: 10, backgroundColor: '#00000010' },
  puceFil: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 5,
  },
  puceFilTexte: { fontFamily: POLICES.corpsGras, fontSize: 12 },
});
