/**
 * Ligne de message, partagée entre l'écran salon et l'écran fil (8.3).
 *
 * Extraite de `app/salon/[rid].tsx` : l'écran fil affiche exactement les
 * mêmes lignes (markdown, messages système, pièces jointes protégées,
 * statuts d'envoi) — la dupliquer aurait fait diverger les deux rendus.
 */

import { useRouter } from 'expo-router';
import { memo, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageStyle,
  type StyleProp,
} from 'react-native';

import type { messages } from '../db/schema.ts';
import {
  isQuoteAttachment,
  MAX_QUOTE_DEPTH,
  stripQuotePrefix,
} from '../lib/quote.ts';
import { attachmentEncryption, type FileEncryption } from '../lib/e2e/crypto.ts';
import { unicodeOfShortcode } from '../lib/emojis.ts';
import { urlEmojiCustom } from '../lib/customEmojis.ts';
import { messageTree } from '../lib/markdown.ts';
import { systemText } from '../lib/systemMessages.ts';
import { reactionList, type DisplayedReaction } from '../lib/reactions.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar, protectedFileUrl } from '../lib/upload.ts';
import { EmbedLinks } from './embedCard.tsx';
import { LinkPreviews } from './linkCard.tsx';
import { offerDownloadOrShare } from './attachmentActions.ts';
import { TransferBar } from './transferBar.tsx';
import { decryptedFile } from './attachment.ts';
import { useEtagsAvatars, useIdentities } from './identities.tsx';
import { useTimeFormatter, useT } from './i18n.ts';
import { AvatarTile } from './kit.tsx';
import { AudioPlayer } from './audioPlayer.tsx';
import { VideoPlayer } from './videoPlayer.tsx';
import { MessageLongPress, MessageBody, RenderGuard } from './markdown.tsx';
import { TappableText } from './tappableText.tsx';
import {
  type Colors,
  LIST_PRESS_DELAY,
  avatarGradient,
  availableBodyWidth,
  FONTS,
  useColors,
} from './theme.ts';
import { useImageViewer } from './imageViewer.tsx';
import { Tappable } from './tappable.tsx';

export type MessageRowData = typeof messages.$inferSelect;

export const MessageRow = memo(function LigneMessage({
  c,
  message,
  client,
  sendStatus: statutEnvoi,
  onRetry: surReessayer,
  onDiscard: surAbandonner,
  onLongPress: surAppuiLong,
  onPress: surAppui,
  onOpenThread: surOuvrirFil,
  me: moi,
  onReact: surReagir,
  continuation: suite,
  repeatedTime: heureRepetee,
}: {
  c: Colors;
  message: MessageRowData;
  client: ClientRest;
  sendStatus: 'en-attente' | 'echec' | null;
  onRetry: (() => void) | null;
  onDiscard: ((id: string) => void) | null;
  onLongPress: ((id: string) => void) | null;
  /** Toucher la ligne (liste des épinglés/favoris). Absent dans un flux. */
  onPress?: ((id: string) => void) | undefined;
  /** Ouvre l'écran du fil. `null` dans l'écran fil lui-même. */
  onOpenThread: ((id: string) => void) | null;
  /** Mon username — marque mes réactions. `null` : rien n'est marqué mien. */
  me: string | null;
  /** Pose/retire une réaction. `null` : pastilles en lecture seule (recherche). */
  onReact: ((rid: string, id: string, code: string, mettre: boolean) => void) | null;
  /**
   * Continuation du message d'au-dessus (même auteur, sous 5 min — calculé par
   * `ui/messageGrouping`) : ni avatar ni pseudo/heure, le corps seul sur la
   * gouttière — les rafales d'un même auteur ne répètent pas son identité.
   */
  continuation: boolean;
  /**
   * Suite dont l'heure affichée (à la minute) est déjà rendue au-dessus
   * (`ui/messageGrouping`, `idsHeuresRepetees`) : la gouttière reste vide —
   * même logique que pour l'avatar, on ne réécrit pas ce qui est à l'écran.
   */
  repeatedTime: boolean;
}) {
  const formatHeure = useTimeFormatter();
  const heure = formatHeure(message.ts);

  const appuiLong = surAppuiLong === null ? undefined : () => surAppuiLong(message.id);
  // Pseudo à AFFICHER, résolu par UID (`ui/identities`) : `auteurNom` est
  // l'instantané figé à l'ingestion, qui reste sur l'ANCIEN nom après un
  // renommage (on ne re-télécharge pas l'historique). La table d'identités,
  // tenue à jour, donne le pseudo courant ; on retombe sur l'instantané tant
  // qu'un uid n'y est pas encore connu (premier rendu, hors-ligne).
  const identites = useIdentities();
  const etags = useEtagsAvatars();
  const t = useT();
  const auteur = (identites.get(message.authorId) ?? message.authorName) ?? '?';
  // Le pseudo prend la première teinte de sa propre tuile-avatar : nom et
  // avatar s'accordent, la même personne garde sa couleur d'un message à l'autre.
  const teinteAuteur = avatarGradient(auteur, c.avatarGradients)[0];
  // Fiche de l'auteur au tap sur l'avatar ou le pseudo. Pas de fiche pour un
  // auteur sans username (message chiffré indéchiffrable : `auteurNom` null).
  // On ouvre par l'UID (`auteurId`), pas par le pseudo affiché : le pseudo est
  // un instantané figé à l'ingestion et devient PÉRIMÉ si la personne se renomme
  // (`users.info?username=ancien` → « user not found »). L'uid, lui, est
  // immuable — la fiche résout donc toujours le profil courant.
  // `ouvrirFicheProfil` précharge la fiche AVANT d'ouvrir la sheet (hauteur
  // finale dès la première frame, pas de saut) — voir lib/profilePreload.
  const ouvrirProfil =
    message.authorName === null
      ? undefined
      : () => void openProfileCard({ uid: message.authorId });

  // Les pièces jointes, citations (`message_link`) séparées des fichiers : la
  // citation se rend AU-DESSUS du corps — on lit d'abord ce à quoi on répond —
  // les fichiers restent en dessous.
  const jointes = useMemo(() => analyserJointes(message.attachments), [message.attachments]);
  const citations = jointes.filter((j) => isQuoteAttachment(j));
  const fichiersJoints = jointes.filter((j) => !isQuoteAttachment(j));

  // Les réactions, ENFIN lues : la colonne était écrite depuis le premier jour
  // et rafraîchie par le stream, mais aucun rendu ne la projetait — réagir ne
  // changeait rien à l'écran et rien n'était retirable (audit, chantier 11).
  const reactions = useMemo(
    () => reactionList(message.reactions, moi),
    [message.reactions, moi],
  );

  return (
    <Pressable
      onLongPress={appuiLong}
      onPress={surAppui === undefined ? undefined : () => surAppui(message.id)}
      delayLongPress={350}
      // Sans quoi le Pressable fusionne la ligne en UN nœud d'accessibilité :
      // TalkBack ne peut plus atteindre « réessayer », « abandonner » ni les
      // pièces jointes individuellement.
      accessible={false}
      style={[
        styles.message,
        suite && styles.messageSuite,
        statutEnvoi === 'en-attente' && styles.pending,
      ]}
    >
      {suite && heureRepetee ? (
        // L'heure de cette suite est déjà affichée au-dessus (même minute) :
        // la gouttière garde sa largeur pour l'alignement, mais reste vide.
        <View style={styles.heureGouttiere} />
      ) : suite ? (
        // Une suite garde la GOUTTIÈRE de l'avatar (le corps reste aligné sur
        // celui du message de tête) et y loge SON heure, en tout petit — le
        // regroupement ne doit pas coûter l'information. `adjustsFontSizeToFit` :
        // l'heure anglaise (« 2:05 PM ») déborde 34 px à taille pleine — elle
        // se resserre plutôt que tronquer.
        <Text
          style={[styles.heureGouttiere, { color: c.tertiaryText }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {heure}
        </Text>
      ) : (
      /* La ligne est `accessible={false}` pour que TalkBack atteigne
          réessayer/abandonner/pièces jointes ; l'initiale décorative ne doit
          pas devenir un nœud de plus, elle double la navigation au balayage.
          (`importantForAccessibility` n'ôte que le nœud a11y — le tap marche.) */
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Pressable
          onPress={ouvrirProfil}
          unstable_pressDelay={LIST_PRESS_DELAY}
          style={({ pressed }) => (pressed && ouvrirProfil !== undefined ? styles.presseAvatar : null)}
        >
          <AvatarTile
            c={c}
            key={auteur}
            initial={auteur.charAt(0) || '?'}
            // Avatar visé par le username COURANT (`identites`), uid en repli.
            // Par uid seul, l'URI `/avatar/uid/<uid>` ne change JAMAIS : le cache
            // image RN garde l'ancien avatar après un renommage, alors que le
            // reste de l'app (par `/avatar/<username>`) affiche le courant. Le
            // username courant fait bouger l'URI au renommage → le cache se
            // rafraîchit et reste cohérent avec l'écran profil.
            // L'`etag` (version de la photo) est ce qui rafraîchit l'image
            // quand la personne change d'avatar : par pseudo si on le connaît,
            // par uid sinon — les deux index pointent la même version.
            uri={urlAvatar(client, {
              username: identites.get(message.authorId),
              uid: message.authorId,
              etag:
                etags.byUsername.get(identites.get(message.authorId) ?? '') ??
                etags.byUid.get(message.authorId),
            })}
            size={34}
            radius={12}
          />
        </Pressable>
      </View>
      )}
      <View style={styles.body}>
        {/* Une suite tait le pseudo et l'heure — mais « modifié » et
            « envoi… » restent dus au lecteur : leur ligne ne se rend que
            quand l'un d'eux a quelque chose à dire. */}
        {(!suite || message.editedAt !== null || statutEnvoi === 'en-attente') && (
          <View style={styles.enTete}>
            {!suite && (
              <TappableText
                style={[styles.author, { color: teinteAuteur }]}
                numberOfLines={1}
                onPress={ouvrirProfil}
                accessibilityLabel={t('ligneMessage.profilDe', { nom: auteur })}
              >
                {auteur}
              </TappableText>
            )}
            {!suite && <Text style={[styles.time, { color: c.tertiaryText }]}>{heure}</Text>}
            {message.editedAt !== null && (
              <Text style={[styles.time, { color: c.tertiaryText }]}>{t('ligneMessage.modifie')}</Text>
            )}
            {statutEnvoi === 'en-attente' && (
              <Text style={[styles.time, { color: c.tertiaryText }]}>{t('ligneMessage.envoiEnCours')}</Text>
            )}
          </View>
        )}
        {citations.map((jointe, i) => (
          <Citation key={i} c={c} attachment={jointe} client={client} onLongPress={appuiLong} />
        ))}
        <MessageLongPress.Provider value={appuiLong}>
          <ContenuMessage c={c} message={message} />
        </MessageLongPress.Provider>
        {message.systemType === null && (
          <EmbedLinks c={c} text={message.text} urls={message.urls} onLongPress={appuiLong} />
        )}
        {message.systemType === null && (
          <LinkPreviews c={c} urls={message.urls} onLongPress={appuiLong} />
        )}
        {fichiersJoints.length > 0 && (
          <PiecesJointes
            c={c}
            attachments={fichiersJoints}
            client={client}
            onLongPress={appuiLong}
          />
        )}
        {reactions.length > 0 && (
          <View style={styles.reactions}>
            {reactions.map((reaction) => (
              <PastilleReaction
                key={reaction.code}
                c={c}
                reaction={reaction}
                // Le tap BASCULE : `chat.react` sait aussi retirer — câbler
                // `mettre` en dur à `true` rendait la réaction inannulable.
                onPress={
                  surReagir === null
                    ? undefined
                    : () => surReagir(message.rid, message.id, reaction.code, !reaction.byMe)
                }
              />
            ))}
          </View>
        )}
        {surOuvrirFil !== null && message.threadCount > 0 && (
          <Pressable
            onPress={() => surOuvrirFil(message.id)}
            style={[styles.puceFil, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <Text style={[styles.puceFilTexte, { color: c.cyan }]}>
              💬 {t('ligneMessage.reponses', { n: message.threadCount })}
              {message.threadLast !== null && ` · ${formatHeure(message.threadLast)}`}
            </Text>
          </Pressable>
        )}
        {statutEnvoi === 'echec' && (
          <View style={styles.actionsEchec}>
            <Pressable onPress={surReessayer ?? undefined}>
              <Text style={[styles.time, { color: c.errorText }]}>{t('ligneMessage.echecReessayer')}</Text>
            </Pressable>
            <Pressable onPress={() => surAbandonner?.(message.id)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('ligneMessage.abandonner')}</Text>
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
function ContenuMessage({ c, message }: { c: Colors; message: MessageRowData }) {
  const t = useT();
  // Clés = les CHAÎNES, stables à travers le barattage d'objets de
  // `useRequeteVive` (qui défait le memo de LigneMessage) : sans cela, chaque
  // écriture en base re-parserait le markdown de toutes les lignes visibles.
  // Un message chiffré DÉCHIFFRÉ (déverrouillé) porte encore `t: 'e2e'` mais a
  // un `texte` : il se rend alors comme un message ordinaire (son `md` est null,
  // `arbreDuMessage` parse le texte clair). Verrouillé, `texte` est null.
  const chiffreDechiffre = message.systemType === 'e2e' && message.text !== null;
  const estOrdinaire = message.systemType === null || chiffreDechiffre;
  const arbre = useMemo(
    () => (estOrdinaire ? messageTree(message.md, message.text) : null),
    [estOrdinaire, message.md, message.text],
  );

  if (message.systemType === 'e2e' && message.text === null) {
    return <Substitut c={c} text={t('ligneMessage.chiffre')} />;
  }
  if (message.systemType === 'videoconf') {
    return <CarteAppel c={c} callId={message.callId} />;
  }
  if (message.systemType !== null && !chiffreDechiffre) {
    // La phrase suit le nom de l'auteur affiché juste au-dessus : « bob a
    // rejoint le salon ». `texte` porte le PARAMÈTRE de l'action, pas une
    // phrase — voir lib/systemMessages.ts.
    return <Substitut c={c} text={systemText(t, message.systemType, message.text)} />;
  }
  if (arbre === null) {
    // Un message d'upload n'a souvent NI texte NI md : ses pièces jointes,
    // rendues à côté, sont tout son contenu — rien à substituer.
    if (message.attachments !== null) return null;
    return <Substitut c={c} text={t('ligneMessage.messageVide')} />;
  }
  return (
    // Le `md` est en dernier ressort une donnée d'autrui : une forme qui
    // échappe aux validations ne doit coûter que ce message, pas l'écran.
    // La `key` fait RENAÎTRE la garde quand le CONTENU change : sans elle,
    // `casse` restait armé pour toujours et l'édition qui corrige un `md`
    // mal formé laissait le message figé sur son texte nu jusqu'au recyclage
    // de la cellule (le garde-fou était le seul maillon sans réarmement).
    <RenderGuard
      key={message.md ?? message.text ?? ''}
      fallback={<Text style={[styles.text, { color: c.text }]}>{message.text}</Text>}
    >
      <MessageBody tree={arbre} c={c} />
    </RenderGuard>
  );
}

function Substitut({ c, text: texte }: { c: Colors; text: string }) {
  return <Text style={[styles.text, styles.italic, { color: c.dimmed }]}>{texte}</Text>;
}

/**
 * Une pastille de réaction : l'emoji (glyphe standard, image custom, ou `:nom:`
 * littéral en dernier ressort — même ordre de résolution que le corps des
 * messages) et le compteur. Contour et compteur ACCENTUÉS quand ma réaction y
 * figure : c'est aussi l'indice que le tap retire au lieu d'ajouter.
 */
function PastilleReaction({
  c,
  reaction,
  onPress: surPresser,
}: {
  c: Colors;
  reaction: DisplayedReaction;
  onPress: (() => void) | undefined;
}) {
  const glyphe = unicodeOfShortcode(reaction.code);
  const uri = glyphe === null ? urlEmojiCustom(reaction.code) : null;
  return (
    <Pressable
      onPress={surPresser}
      disabled={surPresser === undefined}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      accessibilityState={{ selected: reaction.byMe }}
      accessibilityLabel={`:${reaction.code}: ${reaction.total}`}
      style={({ pressed }) => [
        styles.pastilleReaction,
        {
          backgroundColor: c.card,
          borderColor: reaction.byMe ? c.accent : c.border,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      {glyphe !== null ? (
        <Text style={styles.reactionEmoji}>{glyphe}</Text>
      ) : uri !== null ? (
        <Image source={{ uri }} style={styles.reactionImage} resizeMode="contain" />
      ) : (
        <Text style={[styles.reactionCode, { color: c.dimmed }]} numberOfLines={1}>
          :{reaction.code}:
        </Text>
      )}
      <Text
        style={[styles.reactionTotal, { color: reaction.byMe ? c.accent : c.dimmed }]}
      >
        {reaction.total}
      </Text>
    </Pressable>
  );
}

/**
 * Le message CITÉ, au-dessus de la réponse : trait accent, auteur, texte en
 * italique, SES pièces (images en vignette) et — s'il était lui-même une
 * réponse — sa propre citation, imbriquée. Rend la pièce jointe `message_link`
 * que le serveur attache à un message-citation (`lib/quote.ts`) — le même
 * bloc que dessinent les clients officiels, donc les citations croisées entre
 * apps restent lisibles. La chaîne s'arrête à `PROFONDEUR_MAX_CITATION` (2),
 * la taille que produit le serveur (`Message_QuoteChainLimit` par défaut).
 */
function Citation({
  c,
  attachment: jointe,
  client,
  onLongPress: surAppuiLong,
  depth: profondeur = 1,
}: {
  c: Colors;
  attachment: PieceJointe;
  client: ClientRest;
  onLongPress: (() => void) | undefined;
  depth?: number;
}) {
  const t = useT();
  // Le cité peut être lui-même une réponse : on ne montre que ses mots, pas
  // son permalien de citation — sa citation s'affiche en bloc imbriqué.
  const texte = stripQuotePrefix(jointe.text ?? '').trim();
  const auteur = typeof jointe.author_name === 'string' ? jointe.author_name : null;
  const imbriquees = Array.isArray(jointe.attachments) ? jointe.attachments : [];
  const sousCitations =
    profondeur < MAX_QUOTE_DEPTH ? imbriquees.filter((j) => isQuoteAttachment(j)) : [];
  const fichiers = imbriquees.filter((j) => !isQuoteAttachment(j));
  const vide = texte === '' && sousCitations.length === 0 && fichiers.length === 0;
  return (
    <Pressable
      onLongPress={surAppuiLong}
      delayLongPress={350}
      style={[styles.quote, { borderLeftColor: c.accent, backgroundColor: c.card }]}
    >
      {auteur !== null && (
        <Text style={[styles.citationAuteur, { color: c.accent }]} numberOfLines={1}>
          {auteur}
        </Text>
      )}
      {sousCitations.map((sous, i) => (
        <Citation
          key={i}
          c={c}
          attachment={sous}
          client={client}
          onLongPress={surAppuiLong}
          depth={profondeur + 1}
        />
      ))}
      {texte !== '' && (
        <Text style={[styles.text, styles.italic, { color: c.dimmed }]} numberOfLines={4}>
          {texte}
        </Text>
      )}
      {fichiers.map((fichier, i) => (
        <FichierCite key={i} c={c} attachment={fichier} client={client} onLongPress={surAppuiLong} />
      ))}
      {vide && (
        <Text style={[styles.text, styles.italic, { color: c.dimmed }]}>
          📎 {t('commun.pieceJointe')}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Une pièce du message cité, en réduit : l'image en vignette tapable (la
 * visionneuse ouvre l'original), le reste en une ligne titrée — le bloc de
 * citation résume, il ne rejoue pas les lecteurs audio/vidéo.
 */
function FichierCite({
  c,
  attachment: jointe,
  client,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  attachment: PieceJointe;
  client: ClientRest;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  if (typeof jointe.image_url === 'string') {
    // Bornes égales = largeur FIXE : une vignette, pas la pièce plein cadre.
    return (
      <ImageJointe
        attachment={jointe}
        client={client}
        minWidth={LARGEUR_IMAGE_CITEE}
        maxWidth={LARGEUR_IMAGE_CITEE}
        minHeight={72}
        maxHeight={200}
        style={styles.imageCitee}
        onLongPress={surAppuiLong}
      />
    );
  }
  const glyphe =
    typeof jointe.audio_url === 'string' ? '🎵' : typeof jointe.video_url === 'string' ? '🎬' : '📎';
  return (
    <Text style={[styles.text, styles.italic, { color: c.dimmed }]} numberOfLines={1}>
      {glyphe} {jointe.title ?? t('commun.pieceJointe')}
    </Text>
  );
}

/** Largeur fixe des images citées : une vignette, pas la pièce plein cadre. */
const LARGEUR_IMAGE_CITEE = 200;

/**
 * Une image jointe — du bloc citation comme du corps du message : choix de la
 * source, URL protégée, gabarit borné et ouverture en visionneuse. Était écrit
 * deux fois dans ce fichier, avec des bornes déjà divergées.
 *
 * Rocket.Chat génère une VIGNETTE ~480 px (`image_url`) et conserve l'ORIGINAL
 * pleine résolution dans `title_link`. Afficher la vignette la rendait
 * pixelisée dès qu'on l'agrandissait : on prend donc l'original, en le
 * laissant se sous-échantillonner à la taille d'affichage. Repli sur
 * `image_url` si le serveur ne génère pas de vignette (l'original EST alors
 * `image_url`).
 *
 * Le gabarit : largeur naturelle bornée à [largeurMin, largeurMax] (bornes
 * égales = largeur fixe, le cas de la vignette citée), hauteur au ratio de
 * l'original bornée à [hauteurMin, hauteurMax] — un portrait très haut est
 * plafonné (et recadré par `cover`) : la vue en grand, au toucher, montre
 * l'image entière. `image_dimensions` décrit la vignette, mais son RATIO est
 * celui de l'original — parfait pour le gabarit ; carré quand il manque.
 */
function ImageJointe({
  attachment: jointe,
  client,
  minWidth: largeurMin,
  maxWidth: largeurMax,
  minHeight: hauteurMin,
  maxHeight: hauteurMax,
  style,
  onLongPress: surAppuiLong,
  local,
}: {
  attachment: PieceJointe;
  client: ClientRest;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** L'habillage (rayon, marges, fond d'attente) reste à l'appelant. */
  style: StyleProp<ImageStyle>;
  onLongPress: (() => void) | undefined;
  /** Fichier clair déjà dans le cache (image chiffrée) : affiché tel quel. */
  local?: string;
}) {
  const visionneuse = useImageViewer();
  const t = useT();
  const c = useColors();
  if (typeof jointe.image_url !== 'string') return null;
  const source = typeof jointe.title_link === 'string' ? jointe.title_link : jointe.image_url;
  const url = local ?? protectedFileUrl(client, source);
  const reelLargeur = jointe.image_dimensions?.width ?? null;
  const reelHauteur = jointe.image_dimensions?.height ?? null;
  const largeur = Math.max(Math.min(reelLargeur ?? largeurMax, largeurMax), largeurMin);
  const ratio = (reelHauteur ?? largeur) / Math.max(reelLargeur ?? largeur, 1);
  const hauteur = Math.min(Math.max(Math.round(largeur * ratio), hauteurMin), hauteurMax);
  return (
    <Pressable
      onPress={() =>
        visionneuse.open({
          uri: url,
          width: reelLargeur,
          height: reelHauteur,
          title: jointe.title ?? null,
          type: jointe.image_type ?? null,
          key: source,
          size: jointe.image_size ?? null,
        })
      }
      onLongPress={surAppuiLong}
      delayLongPress={350}
      accessibilityRole="imagebutton"
      accessibilityLabel={jointe.title ?? t('ligneMessage.imageAgrandir')}
    >
      <Image
        source={{ uri: url }}
        style={[style, { width: largeur, height: hauteur }]}
        resizeMode="cover"
      />
      <TransferBar key={source} c={c} radius={10} />
    </Pressable>
  );
}

/**
 * Carte d'un message d'appel (`t: 'videoconf'`) : « Appel vidéo » et un bouton
 * Rejoindre qui ouvre l'écran d'appel (WebView Jitsi). Sans `callId` — vieux
 * message d'avant la persistance du bloc, ou bloc illisible — on n'offre pas de
 * jonction, juste l'étiquette : mieux qu'un bouton qui ne saurait où aller.
 */
function CarteAppel({ c, callId }: { c: Colors; callId: string | null }) {
  const routeur = useRouter();
  const t = useT();
  return (
    <View style={[styles.carteAppel, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.carteAppelTitre, { color: c.text }]}>{t('ligneMessage.appelVideo')}</Text>
      {callId !== null && (
        <Tappable
          onPress={() => routeur.push({ pathname: '/call/[callId]', params: { callId } })}
          android_ripple={{ color: c.ripple }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          accessibilityRole="button"
          accessibilityLabel={t('ligneMessage.rejoindreAppel')}
          style={({ pressed }) => [
            styles.rejoindre,
            { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.rejoindreTexte, { color: c.onAccent }]}>{t('ligneMessage.rejoindre')}</Text>
        </Tappable>
      )}
    </View>
  );
}

type PieceJointe = {
  title?: string;
  title_link?: string;
  image_url?: string;
  image_type?: string;
  image_size?: number;
  /** Poids d'une pièce « fichier », en octets. */
  size?: number;
  audio_url?: string;
  audio_type?: string;
  audio_size?: number;
  video_url?: string;
  video_type?: string;
  video_size?: number;
  /** Fichier d'un salon chiffré : sa clé et son compteur (`lib/e2e/crypto.ts`). */
  encryption?: unknown;
  hashes?: unknown;
  image_dimensions?: { width?: number; height?: number };
  /** Citation (reply-quote) : permalien du message cité — voir lib/quote.ts. */
  message_link?: string;
  author_name?: string;
  text?: string;
  /** Pièces du message CITÉ (images, fichiers… et sa propre citation, niveau 2). */
  attachments?: PieceJointe[];
};

/** `piecesJointes` (JSON sérialisé) en tableau — tolérant, comme tout ce qui vient d'autrui. */
function analyserJointes(brut: string | null): PieceJointe[] {
  if (brut === null) return [];
  try {
    const liste = JSON.parse(brut) as unknown;
    return Array.isArray(liste) ? (liste as PieceJointe[]) : [];
  } catch {
    return [];
  }
}

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
  attachments: jointes,
  client,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  attachments: PieceJointe[];
  client: ClientRest;
  onLongPress: (() => void) | undefined;
}) {
  const { width: largeurEcran } = useWindowDimensions();
  const dispoLargeur = availableBodyWidth(largeurEcran);

  return (
    <View style={styles.attachments}>
      {jointes.map((jointe, i) => {
        const chiffrement = attachmentEncryption(jointe);
        if (chiffrement !== null) {
          return (
            <JointeChiffree
              key={i}
              c={c}
              attachment={jointe}
              encryption={chiffrement}
              client={client}
              maxWidth={dispoLargeur}
              onLongPress={surAppuiLong}
            />
          );
        }
        if (typeof jointe?.image_url === 'string') {
          return (
            <ImageJointe
              key={i}
              attachment={jointe}
              client={client}
              minWidth={120}
              maxWidth={dispoLargeur}
              minHeight={0}
              maxHeight={400}
              style={styles.imageJointe}
              onLongPress={surAppuiLong}
            />
          );
        }
        if (typeof jointe?.audio_url === 'string') {
          const url = protectedFileUrl(client, jointe.audio_url);
          return (
            <AudioPlayer
              key={i}
              c={c}
              url={url}
              title={jointe.title ?? null}
              onLongPress={surAppuiLong}
            />
          );
        }
        if (typeof jointe?.video_url === 'string') {
          // Une vidéo porte AUSSI `title_link` (l'original) : cette branche doit
          // passer AVANT la branche « fichier » générique, sinon la vidéo n'y
          // serait qu'un lien ouvert dans le navigateur.
          const url = protectedFileUrl(client, jointe.video_url);
          return (
            <VideoPlayer
              key={i}
              c={c}
              url={url}
              title={jointe.title ?? null}
              onLongPress={surAppuiLong}
              overlay={
                <TransferBar key={jointe.title_link ?? jointe.video_url} c={c} radius={14} />
              }
            />
          );
        }
        if (typeof jointe?.title_link === 'string') {
          return (
            <JointeFichier
              key={i}
              c={c}
              client={client}
              path={jointe.title_link}
              title={jointe.title ?? null}
              size={jointe.size ?? null}
              onLongPress={surAppuiLong}
            />
          );
        }
        return null;
      })}
    </View>
  );
}

/**
 * Pièce jointe « fichier » (PDF, archive, tableur, APK…) : au toucher, le choix
 * — télécharger ou partager — vient AVANT tout téléchargement ; celui-ci suit
 * en fond, sa progression sous le nom (\`ui/attachmentActions.ts\`).
 *
 * L'URL protégée (\`rc_uid\` et \`rc_token\` en query) ne quitte jamais le
 * processus : elle était remise à \`Linking.openURL\`, donc à Chrome, à son
 * historique et à sa synchronisation, et un \`rc_token\` vaut le compte entier.
 */
function JointeFichier({
  c,
  client,
  path: chemin,
  title: titre,
  size: taille,
  onLongPress: surAppuiLong,
  encryption: chiffrement = null,
}: {
  c: Colors;
  client: ClientRest;
  path: string;
  title: string | null;
  size: number | null;
  onLongPress: (() => void) | undefined;
  encryption?: FileEncryption | null;
}) {
  const t = useT();
  // Pas de MIME : \`attachments\` n'en porte pas pour un fichier (son \`type\`
  // vaut « file »). C'est l'extension du nom qui oriente le système.
  const choisir = () =>
    offerDownloadOrShare(
      { key: chemin, url: protectedFileUrl(client, chemin), title: titre, type: null, size: taille, encryption: chiffrement },
      t,
    );

  return (
    <Pressable onPress={choisir} onLongPress={surAppuiLong} delayLongPress={350}>
      <Text style={[styles.text, { color: c.accent }]} numberOfLines={2}>
        📄 {titre ?? t('ligneMessage.fichier')}
      </Text>
      <TransferBar key={chemin} c={c} />
    </Pressable>
  );
}

/** Au-delà, un média chiffré ne se déchiffre pas pour l'aperçu : il se partage ou s'enregistre. */
const APERCU_CHIFFRE_MAX = 25 * 1024 * 1024;

/**
 * Pièce jointe d'un salon chiffré. Le serveur ne détient que du chiffré : une
 * image, un son ou une vidéo se télécharge et se déchiffre dans le cache avant
 * d'être montré, puis se rend comme en clair. Un autre fichier (ou un média
 * trop lourd) reste une carte, déchiffrée au partage ou à l'enregistrement.
 */
function JointeChiffree({
  c,
  attachment: jointe,
  encryption: chiffrement,
  client,
  maxWidth: largeurMax,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  attachment: PieceJointe;
  encryption: FileEncryption;
  client: ClientRest;
  maxWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const chemin = jointe.title_link ?? jointe.image_url ?? jointe.video_url ?? jointe.audio_url;
  const genre =
    typeof jointe.image_url === 'string'
      ? 'image'
      : typeof jointe.video_url === 'string'
        ? 'video'
        : typeof jointe.audio_url === 'string'
          ? 'audio'
          : null;
  const taille = jointe.image_size ?? jointe.video_size ?? jointe.audio_size ?? jointe.size ?? null;
  const type = jointe.image_type ?? jointe.video_type ?? jointe.audio_type ?? null;
  const apercu = genre !== null && chemin !== undefined && (taille ?? 0) <= APERCU_CHIFFRE_MAX;
  const [local, setLocal] = useState<string | null>(null);
  const [echec, setEchec] = useState(false);

  useEffect(() => {
    if (!apercu || chemin === undefined) return;
    let actif = true;
    decryptedFile({
      url: protectedFileUrl(client, chemin),
      title: jointe.title,
      type,
      size: taille,
      encryption: chiffrement,
    }).then(
      (uri) => {
        if (actif) setLocal(uri);
      },
      () => {
        if (actif) setEchec(true);
      },
    );
    return () => {
      actif = false;
    };
  }, [apercu, chemin, client, jointe.title, type, taille, chiffrement]);

  if (chemin === undefined) return null;
  if (!apercu) {
    return (
      <JointeFichier
        c={c}
        client={client}
        path={chemin}
        title={jointe.title ?? null}
        size={taille}
        onLongPress={surAppuiLong}
        encryption={chiffrement}
      />
    );
  }
  if (echec) return <Substitut c={c} text={t('ligneMessage.fichierIllisible')} />;
  if (local === null) {
    return (
      <View style={[styles.imageJointe, styles.attenteChiffree]}>
        <ActivityIndicator color={c.dimmed} />
      </View>
    );
  }
  if (genre === 'image') {
    return (
      <ImageJointe
        attachment={jointe}
        client={client}
        minWidth={120}
        maxWidth={largeurMax}
        minHeight={0}
        maxHeight={400}
        style={styles.imageJointe}
        onLongPress={surAppuiLong}
        local={local}
      />
    );
  }
  if (genre === 'audio') {
    return <AudioPlayer c={c} url={local} title={jointe.title ?? null} onLongPress={surAppuiLong} />;
  }
  return <VideoPlayer c={c} url={local} title={jointe.title ?? null} onLongPress={surAppuiLong} />;
}

const styles = StyleSheet.create({
  message: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  // Suite d'un même auteur : collée au message de tête (l'écart intra-groupe
  // se réduit au paddingBottom du dessus), gouttière = largeur de la tuile,
  // occupée par l'heure du message. `lineHeight` = celle du corps : l'heure
  // s'aligne sur la première ligne de texte.
  messageSuite: { paddingTop: 0 },
  heureGouttiere: {
    width: 34,
    fontFamily: FONTS.body,
    fontSize: 9,
    lineHeight: 20,
    textAlign: 'center',
  },
  body: { flex: 1, gap: 2 },
  pending: { opacity: 0.55 },
  enTete: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  presseAvatar: { opacity: 0.55 },
  author: { fontFamily: FONTS.corpsFort, fontSize: 13.5, flexShrink: 1 },
  time: { fontFamily: FONTS.body, fontSize: 10.5 },
  text: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  italic: { fontStyle: 'italic' },
  actionsEchec: { flexDirection: 'row', gap: 16 },
  quote: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 2,
    gap: 1,
  },
  citationAuteur: { fontFamily: FONTS.corpsGras, fontSize: 12 },
  // La largeur et la hauteur viennent du gabarit d'`ImageJointe`.
  imageCitee: {
    maxWidth: '100%',
    borderRadius: 8,
    backgroundColor: '#00000010',
    marginVertical: 2,
  },
  attachments: { gap: 6, marginTop: 4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  pastilleReaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  reactionEmoji: { fontSize: 14 },
  reactionImage: { width: 16, height: 16 },
  reactionCode: { fontFamily: FONTS.body, fontSize: 11, maxWidth: 90 },
  reactionTotal: { fontFamily: FONTS.corpsGras, fontSize: 12 },
  imageJointe: { borderRadius: 10, backgroundColor: '#00000010' },
  attenteChiffree: { width: 160, height: 120, alignItems: 'center', justifyContent: 'center' },
  puceFil: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 5,
  },
  puceFilTexte: { fontFamily: FONTS.corpsGras, fontSize: 12 },
  carteAppel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 12,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    marginTop: 4,
  },
  carteAppelTitre: { fontFamily: FONTS.corpsGras, fontSize: 14, flexShrink: 1 },
  rejoindre: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 7 },
  rejoindreTexte: { fontFamily: FONTS.corpsFort, fontSize: 13 },
});
