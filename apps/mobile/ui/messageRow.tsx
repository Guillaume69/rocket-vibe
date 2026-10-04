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

export const MessageRow = memo(function MessageRow({
  c,
  message,
  client,
  sendStatus,
  onRetry,
  onDiscard,
  onLongPress,
  onPress,
  onOpenThread,
  me,
  onReact,
  continuation,
  repeatedTime,
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
  onReact: ((rid: string, id: string, code: string, put: boolean) => void) | null;
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
  const formatTime = useTimeFormatter();
  const time = formatTime(message.ts);

  const longPress = onLongPress === null ? undefined : () => onLongPress(message.id);
  // Pseudo à AFFICHER, résolu par UID (`ui/identities`) : `auteurNom` est
  // l'instantané figé à l'ingestion, qui reste sur l'ANCIEN nom après un
  // renommage (on ne re-télécharge pas l'historique). La table d'identités,
  // tenue à jour, donne le pseudo courant ; on retombe sur l'instantané tant
  // qu'un uid n'y est pas encore connu (premier rendu, hors-ligne).
  const identities = useIdentities();
  const etags = useEtagsAvatars();
  const t = useT();
  const author = (identities.get(message.authorId) ?? message.authorName) ?? '?';
  // Le pseudo prend la première teinte de sa propre tuile-avatar : nom et
  // avatar s'accordent, la même personne garde sa couleur d'un message à l'autre.
  const authorTint = avatarGradient(author, c.avatarGradients)[0];
  // Fiche de l'auteur au tap sur l'avatar ou le pseudo. Pas de fiche pour un
  // auteur sans username (message chiffré indéchiffrable : `auteurNom` null).
  // On ouvre par l'UID (`auteurId`), pas par le pseudo affiché : le pseudo est
  // un instantané figé à l'ingestion et devient PÉRIMÉ si la personne se renomme
  // (`users.info?username=ancien` → « user not found »). L'uid, lui, est
  // immuable — la fiche résout donc toujours le profil courant.
  // `ouvrirFicheProfil` précharge la fiche AVANT d'ouvrir la sheet (hauteur
  // finale dès la première frame, pas de saut) — voir lib/profilePreload.
  const openProfile =
    message.authorName === null
      ? undefined
      : () => void openProfileCard({ uid: message.authorId });

  // Les pièces jointes, citations (`message_link`) séparées des fichiers : la
  // citation se rend AU-DESSUS du corps — on lit d'abord ce à quoi on répond —
  // les fichiers restent en dessous.
  const attachments = useMemo(() => parseAttachments(message.attachments), [message.attachments]);
  const quotes = attachments.filter((j) => isQuoteAttachment(j));
  const attachedFiles = attachments.filter((j) => !isQuoteAttachment(j));

  // Les réactions, ENFIN lues : la colonne était écrite depuis le premier jour
  // et rafraîchie par le stream, mais aucun rendu ne la projetait — réagir ne
  // changeait rien à l'écran et rien n'était retirable (audit, chantier 11).
  const reactions = useMemo(
    () => reactionList(message.reactions, me),
    [message.reactions, me],
  );

  return (
    <Pressable
      onLongPress={longPress}
      onPress={onPress === undefined ? undefined : () => onPress(message.id)}
      delayLongPress={350}
      // Sans quoi le Pressable fusionne la ligne en UN nœud d'accessibilité :
      // TalkBack ne peut plus atteindre « réessayer », « abandonner » ni les
      // pièces jointes individuellement.
      accessible={false}
      style={[
        styles.message,
        continuation && styles.messageContinuation,
        sendStatus === 'en-attente' && styles.pending,
      ]}
    >
      {continuation && repeatedTime ? (
        // L'heure de cette suite est déjà affichée au-dessus (même minute) :
        // la gouttière garde sa largeur pour l'alignement, mais reste vide.
        <View style={styles.gutterTime} />
      ) : continuation ? (
        // Une suite garde la GOUTTIÈRE de l'avatar (le corps reste aligné sur
        // celui du message de tête) et y loge SON heure, en tout petit — le
        // regroupement ne doit pas coûter l'information. `adjustsFontSizeToFit` :
        // l'heure anglaise (« 2:05 PM ») déborde 34 px à taille pleine — elle
        // se resserre plutôt que tronquer.
        <Text
          style={[styles.gutterTime, { color: c.tertiaryText }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {time}
        </Text>
      ) : (
      /* La ligne est `accessible={false}` pour que TalkBack atteigne
          réessayer/abandonner/pièces jointes ; l'initiale décorative ne doit
          pas devenir un nœud de plus, elle double la navigation au balayage.
          (`importantForAccessibility` n'ôte que le nœud a11y — le tap marche.) */
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Pressable
          onPress={openProfile}
          unstable_pressDelay={LIST_PRESS_DELAY}
          style={({ pressed }) => (pressed && openProfile !== undefined ? styles.avatarPress : null)}
        >
          <AvatarTile
            c={c}
            key={author}
            initial={author.charAt(0) || '?'}
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
              username: identities.get(message.authorId),
              uid: message.authorId,
              etag:
                etags.byUsername.get(identities.get(message.authorId) ?? '') ??
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
        {(!continuation || message.editedAt !== null || sendStatus === 'en-attente') && (
          <View style={styles.header}>
            {!continuation && (
              <TappableText
                style={[styles.author, { color: authorTint }]}
                numberOfLines={1}
                onPress={openProfile}
                accessibilityLabel={t('messageRow.profileOf', { name: author })}
              >
                {author}
              </TappableText>
            )}
            {!continuation && <Text style={[styles.time, { color: c.tertiaryText }]}>{time}</Text>}
            {message.editedAt !== null && (
              <Text style={[styles.time, { color: c.tertiaryText }]}>{t('messageRow.edited')}</Text>
            )}
            {sendStatus === 'en-attente' && (
              <Text style={[styles.time, { color: c.tertiaryText }]}>{t('messageRow.sending')}</Text>
            )}
          </View>
        )}
        {quotes.map((attachment, i) => (
          <Quote key={i} c={c} attachment={attachment} client={client} onLongPress={longPress} />
        ))}
        <MessageLongPress.Provider value={longPress}>
          <MessageContent c={c} message={message} />
        </MessageLongPress.Provider>
        {message.systemType === null && (
          <EmbedLinks c={c} text={message.text} urls={message.urls} onLongPress={longPress} />
        )}
        {message.systemType === null && (
          <LinkPreviews c={c} urls={message.urls} onLongPress={longPress} />
        )}
        {attachedFiles.length > 0 && (
          <Attachments
            c={c}
            attachments={attachedFiles}
            client={client}
            onLongPress={longPress}
          />
        )}
        {reactions.length > 0 && (
          <View style={styles.reactions}>
            {reactions.map((reaction) => (
              <ReactionChip
                key={reaction.code}
                c={c}
                reaction={reaction}
                // Le tap BASCULE : `chat.react` sait aussi retirer — câbler
                // `mettre` en dur à `true` rendait la réaction inannulable.
                onPress={
                  onReact === null
                    ? undefined
                    : () => onReact(message.rid, message.id, reaction.code, !reaction.byMe)
                }
              />
            ))}
          </View>
        )}
        {onOpenThread !== null && message.threadCount > 0 && (
          <Pressable
            onPress={() => onOpenThread(message.id)}
            style={[styles.threadBullet, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <Text style={[styles.threadBulletText, { color: c.cyan }]}>
              💬 {t('messageRow.replies', { n: message.threadCount })}
              {message.threadLast !== null && ` · ${formatTime(message.threadLast)}`}
            </Text>
          </Pressable>
        )}
        {sendStatus === 'echec' && (
          <View style={styles.failureActions}>
            <Pressable onPress={onRetry ?? undefined}>
              <Text style={[styles.time, { color: c.errorText }]}>{t('messageRow.failedRetry')}</Text>
            </Pressable>
            <Pressable onPress={() => onDiscard?.(message.id)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('messageRow.discard')}</Text>
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
function MessageContent({ c, message }: { c: Colors; message: MessageRowData }) {
  const t = useT();
  // Clés = les CHAÎNES, stables à travers le barattage d'objets de
  // `useRequeteVive` (qui défait le memo de LigneMessage) : sans cela, chaque
  // écriture en base re-parserait le markdown de toutes les lignes visibles.
  // Un message chiffré DÉCHIFFRÉ (déverrouillé) porte encore `t: 'e2e'` mais a
  // un `texte` : il se rend alors comme un message ordinaire (son `md` est null,
  // `arbreDuMessage` parse le texte clair). Verrouillé, `texte` est null.
  const decryptedEncrypted = message.systemType === 'e2e' && message.text !== null;
  const isOrdinary = message.systemType === null || decryptedEncrypted;
  const tree = useMemo(
    () => (isOrdinary ? messageTree(message.md, message.text) : null),
    [isOrdinary, message.md, message.text],
  );

  if (message.systemType === 'e2e' && message.text === null) {
    return <Placeholder c={c} text={t('messageRow.encrypted')} />;
  }
  if (message.systemType === 'videoconf') {
    return <CallCard c={c} callId={message.callId} />;
  }
  if (message.systemType !== null && !decryptedEncrypted) {
    // La phrase suit le nom de l'auteur affiché juste au-dessus : « bob a
    // rejoint le salon ». `texte` porte le PARAMÈTRE de l'action, pas une
    // phrase — voir lib/systemMessages.ts.
    return <Placeholder c={c} text={systemText(t, message.systemType, message.text)} />;
  }
  if (tree === null) {
    // Un message d'upload n'a souvent NI texte NI md : ses pièces jointes,
    // rendues à côté, sont tout son contenu — rien à substituer.
    if (message.attachments !== null) return null;
    return <Placeholder c={c} text={t('messageRow.emptyMessage')} />;
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
      <MessageBody tree={tree} c={c} />
    </RenderGuard>
  );
}

function Placeholder({ c, text }: { c: Colors; text: string }) {
  return <Text style={[styles.text, styles.italic, { color: c.dimmed }]}>{text}</Text>;
}

/**
 * Une pastille de réaction : l'emoji (glyphe standard, image custom, ou `:nom:`
 * littéral en dernier ressort — même ordre de résolution que le corps des
 * messages) et le compteur. Contour et compteur ACCENTUÉS quand ma réaction y
 * figure : c'est aussi l'indice que le tap retire au lieu d'ajouter.
 */
function ReactionChip({
  c,
  reaction,
  onPress,
}: {
  c: Colors;
  reaction: DisplayedReaction;
  onPress: (() => void) | undefined;
}) {
  const glyph = unicodeOfShortcode(reaction.code);
  const uri = glyph === null ? urlEmojiCustom(reaction.code) : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={onPress === undefined}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      accessibilityState={{ selected: reaction.byMe }}
      accessibilityLabel={`:${reaction.code}: ${reaction.total}`}
      style={({ pressed }) => [
        styles.reactionChip,
        {
          backgroundColor: c.card,
          borderColor: reaction.byMe ? c.accent : c.border,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      {glyph !== null ? (
        <Text style={styles.reactionEmoji}>{glyph}</Text>
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
function Quote({
  c,
  attachment,
  client,
  onLongPress,
  depth = 1,
}: {
  c: Colors;
  attachment: Attachment;
  client: ClientRest;
  onLongPress: (() => void) | undefined;
  depth?: number;
}) {
  const t = useT();
  // Le cité peut être lui-même une réponse : on ne montre que ses mots, pas
  // son permalien de citation — sa citation s'affiche en bloc imbriqué.
  const text = stripQuotePrefix(attachment.text ?? '').trim();
  const author = typeof attachment.author_name === 'string' ? attachment.author_name : null;
  const nested = Array.isArray(attachment.attachments) ? attachment.attachments : [];
  const subQuotes =
    depth < MAX_QUOTE_DEPTH ? nested.filter((j) => isQuoteAttachment(j)) : [];
  const files = nested.filter((j) => !isQuoteAttachment(j));
  const empty = text === '' && subQuotes.length === 0 && files.length === 0;
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={350}
      style={[styles.quote, { borderLeftColor: c.accent, backgroundColor: c.card }]}
    >
      {author !== null && (
        <Text style={[styles.quoteAuthor, { color: c.accent }]} numberOfLines={1}>
          {author}
        </Text>
      )}
      {subQuotes.map((sub, i) => (
        <Quote
          key={i}
          c={c}
          attachment={sub}
          client={client}
          onLongPress={onLongPress}
          depth={depth + 1}
        />
      ))}
      {text !== '' && (
        <Text style={[styles.text, styles.italic, { color: c.dimmed }]} numberOfLines={4}>
          {text}
        </Text>
      )}
      {files.map((file, i) => (
        <QuotedFile key={i} c={c} attachment={file} client={client} onLongPress={onLongPress} />
      ))}
      {empty && (
        <Text style={[styles.text, styles.italic, { color: c.dimmed }]}>
          📎 {t('common.attachment')}
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
function QuotedFile({
  c,
  attachment,
  client,
  onLongPress,
}: {
  c: Colors;
  attachment: Attachment;
  client: ClientRest;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  if (typeof attachment.image_url === 'string') {
    // Bornes égales = largeur FIXE : une vignette, pas la pièce plein cadre.
    return (
      <AttachedImage
        attachment={attachment}
        client={client}
        minWidth={QUOTED_IMAGE_WIDTH}
        maxWidth={QUOTED_IMAGE_WIDTH}
        minHeight={72}
        maxHeight={200}
        style={styles.quotedImage}
        onLongPress={onLongPress}
      />
    );
  }
  const glyph =
    typeof attachment.audio_url === 'string' ? '🎵' : typeof attachment.video_url === 'string' ? '🎬' : '📎';
  return (
    <Text style={[styles.text, styles.italic, { color: c.dimmed }]} numberOfLines={1}>
      {glyph} {attachment.title ?? t('common.attachment')}
    </Text>
  );
}

/** Largeur fixe des images citées : une vignette, pas la pièce plein cadre. */
const QUOTED_IMAGE_WIDTH = 200;

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
function AttachedImage({
  attachment,
  client,
  minWidth,
  maxWidth,
  minHeight,
  maxHeight,
  style,
  onLongPress,
  local,
}: {
  attachment: Attachment;
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
  const viewer = useImageViewer();
  const t = useT();
  const c = useColors();
  if (typeof attachment.image_url !== 'string') return null;
  const source = typeof attachment.title_link === 'string' ? attachment.title_link : attachment.image_url;
  const url = local ?? protectedFileUrl(client, source);
  const realWidth = attachment.image_dimensions?.width ?? null;
  const realHeight = attachment.image_dimensions?.height ?? null;
  const width = Math.max(Math.min(realWidth ?? maxWidth, maxWidth), minWidth);
  const ratio = (realHeight ?? width) / Math.max(realWidth ?? width, 1);
  const height = Math.min(Math.max(Math.round(width * ratio), minHeight), maxHeight);
  return (
    <Pressable
      onPress={() =>
        viewer.open({
          uri: url,
          width: realWidth,
          height: realHeight,
          title: attachment.title ?? null,
          type: attachment.image_type ?? null,
          key: source,
          size: attachment.image_size ?? null,
        })
      }
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="imagebutton"
      accessibilityLabel={attachment.title ?? t('messageRow.imageEnlarge')}
    >
      <Image
        source={{ uri: url }}
        style={[style, { width, height }]}
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
function CallCard({ c, callId }: { c: Colors; callId: string | null }) {
  const router = useRouter();
  const t = useT();
  return (
    <View style={[styles.callCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.callCardTitle, { color: c.text }]}>{t('messageRow.videoCall')}</Text>
      {callId !== null && (
        <Tappable
          onPress={() => router.push({ pathname: '/call/[callId]', params: { callId } })}
          android_ripple={{ color: c.ripple }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          accessibilityRole="button"
          accessibilityLabel={t('messageRow.joinCall')}
          style={({ pressed }) => [
            styles.join,
            { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.joinText, { color: c.onAccent }]}>{t('messageRow.join')}</Text>
        </Tappable>
      )}
    </View>
  );
}

type Attachment = {
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
  attachments?: Attachment[];
};

/** `piecesJointes` (JSON sérialisé) en tableau — tolérant, comme tout ce qui vient d'autrui. */
function parseAttachments(raw: string | null): Attachment[] {
  if (raw === null) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as Attachment[]) : [];
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
function Attachments({
  c,
  attachments,
  client,
  onLongPress,
}: {
  c: Colors;
  attachments: Attachment[];
  client: ClientRest;
  onLongPress: (() => void) | undefined;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const availableWidth = availableBodyWidth(screenWidth);

  return (
    <View style={styles.attachments}>
      {attachments.map((attachment, i) => {
        const encryption = attachmentEncryption(attachment);
        if (encryption !== null) {
          return (
            <EncryptedAttachment
              key={i}
              c={c}
              attachment={attachment}
              encryption={encryption}
              client={client}
              maxWidth={availableWidth}
              onLongPress={onLongPress}
            />
          );
        }
        if (typeof attachment?.image_url === 'string') {
          return (
            <AttachedImage
              key={i}
              attachment={attachment}
              client={client}
              minWidth={120}
              maxWidth={availableWidth}
              minHeight={0}
              maxHeight={400}
              style={styles.attachedImage}
              onLongPress={onLongPress}
            />
          );
        }
        if (typeof attachment?.audio_url === 'string') {
          const url = protectedFileUrl(client, attachment.audio_url);
          return (
            <AudioPlayer
              key={i}
              c={c}
              url={url}
              title={attachment.title ?? null}
              onLongPress={onLongPress}
            />
          );
        }
        if (typeof attachment?.video_url === 'string') {
          // Une vidéo porte AUSSI `title_link` (l'original) : cette branche doit
          // passer AVANT la branche « fichier » générique, sinon la vidéo n'y
          // serait qu'un lien ouvert dans le navigateur.
          const url = protectedFileUrl(client, attachment.video_url);
          return (
            <VideoPlayer
              key={i}
              c={c}
              url={url}
              title={attachment.title ?? null}
              onLongPress={onLongPress}
              overlay={
                <TransferBar key={attachment.title_link ?? attachment.video_url} c={c} radius={14} />
              }
            />
          );
        }
        if (typeof attachment?.title_link === 'string') {
          return (
            <FileAttachment
              key={i}
              c={c}
              client={client}
              path={attachment.title_link}
              title={attachment.title ?? null}
              size={attachment.size ?? null}
              onLongPress={onLongPress}
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
function FileAttachment({
  c,
  client,
  path,
  title,
  size,
  onLongPress,
  encryption = null,
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
  const pick = () =>
    offerDownloadOrShare(
      { key: path, url: protectedFileUrl(client, path), title, type: null, size, encryption },
      t,
    );

  return (
    <Pressable onPress={pick} onLongPress={onLongPress} delayLongPress={350}>
      <Text style={[styles.text, { color: c.accent }]} numberOfLines={2}>
        📄 {title ?? t('messageRow.file')}
      </Text>
      <TransferBar key={path} c={c} />
    </Pressable>
  );
}

/** Au-delà, un média chiffré ne se déchiffre pas pour l'aperçu : il se partage ou s'enregistre. */
const ENCRYPTED_PREVIEW_MAX = 25 * 1024 * 1024;

/**
 * Pièce jointe d'un salon chiffré. Le serveur ne détient que du chiffré : une
 * image, un son ou une vidéo se télécharge et se déchiffre dans le cache avant
 * d'être montré, puis se rend comme en clair. Un autre fichier (ou un média
 * trop lourd) reste une carte, déchiffrée au partage ou à l'enregistrement.
 */
function EncryptedAttachment({
  c,
  attachment,
  encryption,
  client,
  maxWidth,
  onLongPress,
}: {
  c: Colors;
  attachment: Attachment;
  encryption: FileEncryption;
  client: ClientRest;
  maxWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const path = attachment.title_link ?? attachment.image_url ?? attachment.video_url ?? attachment.audio_url;
  const kind =
    typeof attachment.image_url === 'string'
      ? 'image'
      : typeof attachment.video_url === 'string'
        ? 'video'
        : typeof attachment.audio_url === 'string'
          ? 'audio'
          : null;
  const size = attachment.image_size ?? attachment.video_size ?? attachment.audio_size ?? attachment.size ?? null;
  const type = attachment.image_type ?? attachment.video_type ?? attachment.audio_type ?? null;
  const preview = kind !== null && path !== undefined && (size ?? 0) <= ENCRYPTED_PREVIEW_MAX;
  const [local, setLocal] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);

  useEffect(() => {
    if (!preview || path === undefined) return;
    let active = true;
    decryptedFile({
      url: protectedFileUrl(client, path),
      title: attachment.title,
      type,
      size,
      encryption,
    }).then(
      (uri) => {
        if (active) setLocal(uri);
      },
      () => {
        if (active) setFailure(true);
      },
    );
    return () => {
      active = false;
    };
  }, [preview, path, client, attachment.title, type, size, encryption]);

  if (path === undefined) return null;
  if (!preview) {
    return (
      <FileAttachment
        c={c}
        client={client}
        path={path}
        title={attachment.title ?? null}
        size={size}
        onLongPress={onLongPress}
        encryption={encryption}
      />
    );
  }
  if (failure) return <Placeholder c={c} text={t('messageRow.fileUnreadable')} />;
  if (local === null) {
    return (
      <View style={[styles.attachedImage, styles.encryptedPending]}>
        <ActivityIndicator color={c.dimmed} />
      </View>
    );
  }
  if (kind === 'image') {
    return (
      <AttachedImage
        attachment={attachment}
        client={client}
        minWidth={120}
        maxWidth={maxWidth}
        minHeight={0}
        maxHeight={400}
        style={styles.attachedImage}
        onLongPress={onLongPress}
        local={local}
      />
    );
  }
  if (kind === 'audio') {
    return <AudioPlayer c={c} url={local} title={attachment.title ?? null} onLongPress={onLongPress} />;
  }
  return <VideoPlayer c={c} url={local} title={attachment.title ?? null} onLongPress={onLongPress} />;
}

const styles = StyleSheet.create({
  message: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  // Suite d'un même auteur : collée au message de tête (l'écart intra-groupe
  // se réduit au paddingBottom du dessus), gouttière = largeur de la tuile,
  // occupée par l'heure du message. `lineHeight` = celle du corps : l'heure
  // s'aligne sur la première ligne de texte.
  messageContinuation: { paddingTop: 0 },
  gutterTime: {
    width: 34,
    fontFamily: FONTS.body,
    fontSize: 9,
    lineHeight: 20,
    textAlign: 'center',
  },
  body: { flex: 1, gap: 2 },
  pending: { opacity: 0.55 },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  avatarPress: { opacity: 0.55 },
  author: { fontFamily: FONTS.bodyStrong, fontSize: 13.5, flexShrink: 1 },
  time: { fontFamily: FONTS.body, fontSize: 10.5 },
  text: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  italic: { fontStyle: 'italic' },
  failureActions: { flexDirection: 'row', gap: 16 },
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
  quoteAuthor: { fontFamily: FONTS.bodyBold, fontSize: 12 },
  // La largeur et la hauteur viennent du gabarit d'`ImageJointe`.
  quotedImage: {
    maxWidth: '100%',
    borderRadius: 8,
    backgroundColor: '#00000010',
    marginVertical: 2,
  },
  attachments: { gap: 6, marginTop: 4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  reactionChip: {
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
  reactionTotal: { fontFamily: FONTS.bodyBold, fontSize: 12 },
  attachedImage: { borderRadius: 10, backgroundColor: '#00000010' },
  encryptedPending: { width: 160, height: 120, alignItems: 'center', justifyContent: 'center' },
  threadBullet: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 5,
  },
  threadBulletText: { fontFamily: FONTS.bodyBold, fontSize: 12 },
  callCard: {
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
  callCardTitle: { fontFamily: FONTS.bodyBold, fontSize: 14, flexShrink: 1 },
  join: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 7 },
  joinText: { fontFamily: FONTS.bodyStrong, fontSize: 13 },
});
