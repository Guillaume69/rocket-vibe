/**
 * Message row, shared between the room screen and the thread screen (8.3).
 *
 * Extracted from `app/room/[rid].tsx`: the thread screen shows exactly the
 * same rows (markdown, system messages, protected attachments, send states);
 * duplicating it would have made the two renderings diverge.
 */

import { useRouter } from 'expo-router';
import {callContext} from '../lib/call.ts';
import {useSession} from './session.tsx';
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
  quoteText,
} from '../lib/quote.ts';
import { attachmentEncryption, type FileEncryption } from '../lib/e2e/crypto.ts';
import { unicodeOfShortcode } from '../lib/emojis.ts';
import { customEmojiUrl } from '../lib/customEmojis.ts';
import {ImageEmoji,useCatalogueEmojis} from './emojiImage.tsx';
import { recordReaction } from './emojiUsage.ts';
import { isDeletedUsername } from '../lib/deletedUser.ts';
import { messageTree } from '../lib/markdown.ts';
import { useJoinVoice, useVoice } from './voice.tsx';
import { callSummaryText, systemText } from '../lib/systemMessages.ts';
import { reactionList, type DisplayedReaction } from '../lib/reactions.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl, protectedFileUrl } from '../lib/upload.ts';
import { EmbedLinks } from './embedCard.tsx';
import { LinkPreviews } from './linkCard.tsx';
import {integrationCard} from '../lib/integrationCards.ts';
import {IntegrationCard} from './integrationCard.tsx';
import { offerDownloadOrShare } from './attachmentActions.ts';
import { TransferBar } from './transferBar.tsx';
import { decryptedFile } from './attachment.ts';
import {subscribeNativeFile} from '../lib/nativeFiles.ts';
import { useAvatarEtags, useIdentities } from './identities.tsx';
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
  failureLabel,
  threadLabel,
}: {
  c: Colors;
  message: MessageRowData;
  client: RestClient;
  sendStatus: 'pending' | 'failed' | null;
  onRetry: (() => void) | null;
  onDiscard: ((id: string) => void) | null;
  onLongPress: ((id: string) => void) | null;
  /** Tap on the row (pinned/starred list). Absent in a timeline. */
  onPress?: ((id: string) => void) | undefined;
  /** Opens the thread screen. `null` in the thread screen itself. */
  onOpenThread: ((id: string) => void) | null;
  /** My username, marks my reactions. `null`: nothing is marked mine. */
  me: string | null;
  /** Adds/removes a reaction. `null`: read-only chips (search). */
  onReact: ((rid: string, id: string, code: string, put: boolean) => void) | null;
  /**
   * Continuation of the message above (same author, within 5 min, computed by
   * `ui/messageGrouping`): no avatar nor username/time, the body alone on the
   * gutter, so one author's bursts do not repeat their identity.
   */
  continuation: boolean;
  /**
   * Continuation whose displayed time (to the minute) is already rendered above
   * (`ui/messageGrouping`, `repeatedTimeIds`): the gutter stays empty. Same
   * logic as for the avatar: what is on screen is not rewritten.
   */
  repeatedTime: boolean;
  failureLabel?: string;
  /** Enables starting a retained private thread, also before its first reply. */
  threadLabel?: string;
}) {
  const formatTime = useTimeFormatter();
  const time = formatTime(message.ts);

  const longPress = onLongPress === null ? undefined : () => onLongPress(message.id);
  // Username to DISPLAY, resolved by UID (`ui/identities`): `authorName` is the
  // snapshot frozen at ingestion, which keeps the OLD name after a rename (the
  // history is not re-downloaded). The identity table, kept up to date, gives the
  // current username; we fall back on the snapshot while a uid is not known yet
  // (first render, offline).
  const identities = useIdentities();
  const etags = useAvatarEtags();
  const t = useT();
  const username = (identities.get(message.authorId) ?? message.authorName) ?? '?';
  // A deleted RocketVibe account keeps its messages (`lib/deletedUser.ts`).
  const deletedAuthor = client.kind === 'rocketvibe' && isDeletedUsername(username);
  const author = deletedAuthor ? t('common.deletedUser') : username;
  // The username takes the first tint of its own avatar tile: name and avatar
  // match, and the same person keeps their color from one message to the next.
  const authorTint = avatarGradient(author, c.avatarGradients)[0];
  // Author card on tapping the avatar or username. No card for an author
  // without a username (undecryptable encrypted message: `authorName` null).
  // Opened by UID (`authorId`), not by the displayed username: the username is
  // a snapshot frozen at ingestion and goes STALE if the person renames
  // (`users.info?username=old` → "user not found"). The uid is immutable, so
  // the card always resolves the current profile.
  // `openProfileCard` preloads the card BEFORE opening the sheet (final height
  // from the first frame, no jump), see lib/profilePreload.
  const openProfile =
    message.authorName === null || deletedAuthor
      ? undefined
      : () => void openProfileCard({ uid: message.authorId });

  // Attachments: quotes (`message_link`) split from files. The quote renders
  // ABOVE the body (one reads first what is being replied to); files stay below.
  const attachments = useMemo(() => parseAttachments(message.attachments), [message.attachments]);
  const quotes = attachments.filter((j) => isQuoteAttachment(j));
  const attachedFiles = attachments.filter((j) => !isQuoteAttachment(j));

  // Reactions, FINALLY read: the column was written from day one and refreshed
  // by the stream, but no render projected it; reacting changed nothing on screen
  // and nothing could be removed (audit, workstream 11).
  const reactions = useMemo(
    () => reactionList(message.reactions, me),
    [message.reactions, me],
  );

  return (
    <Pressable
      onLongPress={longPress}
      onPress={onPress === undefined ? undefined : () => onPress(message.id)}
      delayLongPress={350}
      // Otherwise the Pressable merges the row into ONE accessibility node:
      // TalkBack can no longer reach "retry", "discard" or individual
      // attachments.
      accessible={false}
      style={[
        styles.message,
        continuation && styles.messageContinuation,
        sendStatus === 'pending' && styles.pending,
      ]}
    >
      {continuation && repeatedTime ? (
        // This continuation's time is already shown above (same minute): the
        // gutter keeps its width for alignment, but stays empty.
        <View style={styles.gutterTime} />
      ) : continuation ? (
        // A continuation keeps the avatar GUTTER (the body stays aligned with the
        // head message's) and puts ITS time there, very small: grouping must not
        // cost the information. `adjustsFontSizeToFit`: the English time
        // ("2:05 PM") overflows 34 px at full size; it shrinks rather than
        // truncating.
        <Text
          style={[styles.gutterTime, { color: c.tertiaryText }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {time}
        </Text>
      ) : (
      /* The row is `accessible={false}` so TalkBack reaches
          retry/discard/attachments; the decorative initial must not
          become one more node, it would double swipe navigation.
          (`importantForAccessibility` only removes the a11y node; tap still works.) */
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Pressable
          onPress={openProfile}
          unstable_pressDelay={LIST_PRESS_DELAY}
          style={({ pressed }) => (pressed && openProfile !== undefined ? styles.avatarPress : null)}
        >
          <AvatarTile
            c={c}
            hueKey={author}
            initial={author.charAt(0) || '?'}
            // Avatar addressed by the CURRENT username (`identities`), uid as fallback.
            // By uid alone, the URI `/avatar/uid/<uid>` NEVER changes: RN's image
            // cache keeps the old avatar after a rename, while the rest of the app
            // (by `/avatar/<username>`) shows the current one. The current username
            // moves the URI on rename → the cache refreshes and stays consistent
            // with the profile screen.
            // The `etag` (photo version) is what refreshes the image when the
            // person changes avatar: by username if known, by uid otherwise; both
            // indexes point to the same version.
            uri={avatarUrl(client, {
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
        {/* A continuation hides username and time, but "edited" and
            "sending..." are still owed to the reader: their line only renders
            when one of them has something to say. */}
        {(!continuation || message.editedAt !== null || sendStatus === 'pending') && (
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
            {sendStatus === 'pending' && (
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
            <EmbedLinks c={c} client={client} text={message.text} urls={message.urls} onLongPress={longPress} />
        )}
        {message.systemType === null && (
          <LinkPreviews c={c} client={client} urls={message.urls} onLongPress={longPress} />
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
                // The tap TOGGLES: `chat.react` can also remove; hard-wiring `put`
                // to `true` made the reaction impossible to undo.
                onPress={
                  onReact === null
                    ? undefined
                    : () => {
                        // Joining a reaction is a use of that emoji (quick
                        // reactions of the sheet); withdrawing mine is not.
                        if (!reaction.byMe) recordReaction(reaction.code);
                        onReact(message.rid, message.id, reaction.code, !reaction.byMe);
                      }
                }
              />
            ))}
          </View>
        )}
        {onOpenThread !== null && (message.threadCount > 0 || threadLabel !== undefined) && (
          <Pressable
            onPress={() => onOpenThread(message.id)}
            style={[styles.threadBullet, { backgroundColor: c.card, borderColor: c.border }]}
          >
            <Text style={[styles.threadBulletText, { color: c.cyan }]}>
              💬 {threadLabel ?? t('messageRow.replies', { n: message.threadCount })}
              {message.threadLast !== null && ` · ${formatTime(message.threadLast)}`}
            </Text>
          </Pressable>
        )}
        {sendStatus === 'failed' && (
          <View style={styles.failureActions}>
            <Pressable onPress={onRetry ?? undefined}>
              <Text style={[styles.time, { color: c.errorText }]}>{failureLabel ?? t('messageRow.failedRetry')}</Text>
            </Pressable>
            {onDiscard && <Pressable onPress={() => onDiscard(message.id)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('messageRow.discard')}</Text>
            </Pressable>}
          </View>
        )}
      </View>
    </Pressable>
  );
});

/**
 * Message body: markdown for ordinary messages (server `md`, or local
 * `parse()` for OLD messages that have none, a fallback required by contract
 * 4.3), a plain stand-in for encrypted and system messages (their translation
 * comes in 4.4).
 */
function MessageContent({ c, message }: { c: Colors; message: MessageRowData }) {
  const t = useT();
  // Keys = the STRINGS, stable across the object churn of
  // `useCoalescedLiveQuery` (which defeats MessageRow's memo): otherwise every
  // database write would re-parse the markdown of every visible row.
  // A DECRYPTED (unlocked) encrypted message still carries `t: 'e2e'` but has
  // a `text`: it then renders like an ordinary message (its `md` is null,
  // `messageTree` parses the plaintext). Locked, `text` is null.
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
    return <CallCard c={c} callId={message.callId} rid={message.rid} />;
  }
  if (message.systemType?.startsWith('rv-call')) {
    return <VoiceCallCard c={c} rid={message.rid} type={message.systemType} param={message.text ?? ''} />;
  }
  if (message.systemType !== null && !decryptedEncrypted) {
    // The sentence follows the author name shown just above: "bob joined the
    // room". `text` carries the action's PARAMETER, not a sentence, see
    // lib/systemMessages.ts.
    return <Placeholder c={c} text={systemText(t, message.systemType, message.text)} />;
  }
  if (tree === null) {
    // An upload message often has NEITHER text NOR md: its attachments,
    // rendered alongside, are all its content; nothing to stand in for.
    if (message.attachments !== null) return null;
    return <Placeholder c={c} text={t('messageRow.emptyMessage')} />;
  }
  return (
    // The `md` is ultimately someone else's data: a shape that slips past
    // validation must cost only this message, not the screen.
    // The `key` REVIVES the guard when the CONTENT changes: without it,
    // `crashed` stayed armed forever and an edit fixing a malformed `md`
    // left the message stuck on its bare text until the cell was recycled
    // (the guard was the only link with no reset).
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
 * A reaction chip: the emoji (standard glyph, custom image, or literal `:name:`
 * as a last resort, same resolution order as the message body) and the count.
 * Border and count ACCENTED when my reaction is in it: that is also the hint
 * that tapping removes instead of adding.
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
  useCatalogueEmojis();
  const glyph = unicodeOfShortcode(reaction.code);
  const uri = glyph === null ? customEmojiUrl(reaction.code) : null;
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
        <ImageEmoji uri={uri} style={styles.reactionImage} code={reaction.code}/>
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
 * The QUOTED message, above the reply: accent bar, author, italic text, ITS
 * attachments (images as thumbnails) and, if it was itself a reply, its own
 * quote, nested. Renders the `message_link` attachment the server attaches to a
 * quote message (`lib/quote.ts`), the same block the official clients draw, so
 * cross-app quotes stay readable. The chain stops at `MAX_QUOTE_DEPTH` (2),
 * the size the server produces (default `Message_QuoteChainLimit`).
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
  client: RestClient;
  onLongPress: (() => void) | undefined;
  depth?: number;
}) {
  const t = useT();
  // The quoted message may itself be a reply: show only its words, not its
  // quote permalink; its quote shows as a nested block.
  const text = quoteText(attachment).trim();
  // A private source names its author by uid: shown as the rows show it.
  const identities = useIdentities();
  const named = typeof attachment.author_name === 'string' ? attachment.author_name : null;
  const current = named === null ? null : (identities.get(named) ?? named);
  const author = client.kind === 'rocketvibe' && isDeletedUsername(current) ? t('common.deletedUser') : current;
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
          {attachment.native_unavailable === true ? t('quote.unavailable') : `📎 ${t('common.attachment')}`}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * An attachment of the quoted message, scaled down: the image as a tappable
 * thumbnail (the viewer opens the original), the rest as one titled line; the
 * quote block summarizes, it does not replay audio/video players.
 */
function QuotedFile({
  c,
  attachment,
  client,
  onLongPress,
}: {
  c: Colors;
  attachment: Attachment;
  client: RestClient;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  if (typeof attachment.image_url === 'string') {
    if(attachment.native_file)return <NativeAttachment c={c} attachment={attachment} client={client} maxWidth={QUOTED_IMAGE_WIDTH} onLongPress={onLongPress} quoted/>;
    // Equal bounds = FIXED width: a thumbnail, not the full-frame attachment.
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

/** Fixed width of quoted images: a thumbnail, not the full-frame attachment. */
const QUOTED_IMAGE_WIDTH = 200;

/**
 * An attached image, from the quote block as from the message body: source
 * choice, protected URL, bounded frame and opening in the viewer. Was written
 * twice in this file, with bounds that had already diverged.
 *
 * Rocket.Chat generates a ~480 px THUMBNAIL (`image_url`) and keeps the
 * full-resolution ORIGINAL in `title_link`. Showing the thumbnail made it
 * pixelated as soon as it was enlarged, so we take the original and let it
 * downsample to the display size. Falls back to `image_url` if the server
 * generates no thumbnail (the original then IS `image_url`).
 *
 * The frame: natural width bounded to [minWidth, maxWidth] (equal bounds =
 * fixed width, the quoted thumbnail case), height at the original's ratio
 * bounded to [minHeight, maxHeight]; a very tall portrait is capped (and
 * cropped by `cover`): the full view, on tap, shows the whole image.
 * `image_dimensions` describes the thumbnail, but its RATIO is the original's,
 * perfect for the frame; square when missing.
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
  client: RestClient;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** Styling (radius, margins, placeholder background) is left to the caller. */
  style: StyleProp<ImageStyle>;
  onLongPress: (() => void) | undefined;
  /** Plaintext file already in the cache (encrypted image): shown as is. */
  local?: string;
}) {
  const viewer = useImageViewer();
  const t = useT();
  const c = useColors();
  // Without announced dimensions (a private file's descriptor carries none),
  // the decoded picture gives them: a square frame cropped it.
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  if (typeof attachment.image_url !== 'string') return null;
  const source = typeof attachment.title_link === 'string' ? attachment.title_link : attachment.image_url;
  const url = local ?? protectedFileUrl(client, source);
  const realWidth = attachment.image_dimensions?.width ?? measured?.width ?? null;
  const realHeight = attachment.image_dimensions?.height ?? measured?.height ?? null;
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
        onLoad={
          attachment.image_dimensions
            ? undefined
            : (e) => {
                const { width: w, height: h } = e.nativeEvent.source;
                if (w > 0 && h > 0) setMeasured((m) => (m?.width === w && m.height === h ? m : { width: w, height: h }));
              }
        }
      />
      <TransferBar transfer={source} c={c} radius={10} />
    </Pressable>
  );
}

/**
 * Card of a call message (`t: 'videoconf'`): "Video call" and a Join button
 * that opens the call screen (Jitsi WebView). Without a `callId` (an old message
 * from before the block was persisted, or an unreadable block) no join is
 * offered, just the label: better than a button that would not know where to go.
 */
function CallCard({ c, callId,rid }: { c: Colors; callId: string | null;rid:string }) {
  const router = useRouter();
  const t = useT();
  const {state}=useSession();
  return (
    <View style={[styles.callCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.callCardTitle, { color: c.text }]}>{t('messageRow.videoCall')}</Text>
      {callId !== null && (
        <Tappable
          onPress={() => {if(state.phase==='connected')router.push({ pathname: '/call/[callId]', params: { callId,rid,account:callContext(state.client) } });}}
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

/**
 * A RocketVibe call row: its outcome and, once over, how long it lasted. A
 * call still going is joined; one that ended is called back (a DM rings).
 */
function VoiceCallCard({ c, rid, type, param }: { c: Colors; rid: string; type: string; param: string }) {
  const t = useT();
  const join = useJoinVoice();
  const voice = useVoice();
  const ongoing = type === 'rv-call-ringing' || type === 'rv-call-answered' && param === '';
  const here = voice.room === rid && voice.phase !== 'idle';
  return (
    <View style={[styles.callCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.callCardTitle, { color: type === 'rv-call-missed' ? c.danger : c.text }]}>
        {callSummaryText(t, type, param)}
      </Text>
      {type !== 'rv-call' && !here && (
        <Tappable
          onPress={() => void join(rid, t('voice.title'), !ongoing, true)}
          android_ripple={{ color: c.ripple }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          accessibilityRole="button"
          style={({ pressed }) => [styles.join, { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.joinText, { color: c.onAccent }]}>{ongoing ? t('messageRow.join') : t('call.back')}</Text>
        </Tappable>
      )}
    </View>
  );
}

type Attachment = {
  native_file?: unknown;
  native_unavailable?: boolean;
  title?: string;
  title_link?: string;
  image_url?: string;
  image_type?: string;
  image_size?: number;
  /** Size of a "file" attachment, in bytes. */
  size?: number;
  audio_url?: string;
  audio_type?: string;
  audio_size?: number;
  video_url?: string;
  video_type?: string;
  video_size?: number;
  /** File of an encrypted room: its key and counter (`lib/e2e/crypto.ts`). */
  encryption?: unknown;
  hashes?: unknown;
  image_dimensions?: { width?: number; height?: number };
  /** Quote (reply-quote): permalink of the quoted message, see lib/quote.ts. */
  message_link?: string;
  author_name?: string;
  text?: string;
  /** Attachments of the QUOTED message (images, files... and its own quote, level 2). */
  attachments?: Attachment[];
};

/** `attachments` (serialized JSON) as an array: tolerant, like everything from someone else. */
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
 * Attachments (7.4): `FileUpload_ProtectFiles = true` on the target server, so
 * every file URL gets `rc_uid`/`rc_token` in the query, otherwise the server
 * answers 403 and the image stays blank.
 *
 * `onLongPress` is passed to every tappable element: a touch starting on a
 * child Pressable never bubbles up to the row's Pressable, and an upload
 * message (no text) would offer NO surface for the action sheet.
 */
function Attachments({
  c,
  attachments,
  client,
  onLongPress,
}: {
  c: Colors;
  attachments: Attachment[];
  client: RestClient;
  onLongPress: (() => void) | undefined;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const availableWidth = availableBodyWidth(screenWidth);

  return (
    <View style={styles.attachments}>
      {attachments.map((attachment, i) => {
        const card=integrationCard(attachment);
        if(card)return <IntegrationCard key={i} c={c} card={card} onLongPress={onLongPress}/>;
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
        if(client.kind==='rocketvibe'&&typeof attachment.title_link==='string'){
          return <NativeAttachment key={i} c={c} attachment={attachment} client={client} maxWidth={availableWidth} onLongPress={onLongPress}/>;
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
          // A video ALSO carries `title_link` (the original): this branch must
          // come BEFORE the generic "file" branch, otherwise the video would only
          // be a link opened in the browser.
          const url = protectedFileUrl(client, attachment.video_url);
          return (
            <VideoPlayer
              key={i}
              c={c}
              url={url}
              title={attachment.title ?? null}
              onLongPress={onLongPress}
              overlay={
                <TransferBar transfer={attachment.title_link ?? attachment.video_url} c={c} radius={14} />
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
 * "File" attachment (PDF, archive, spreadsheet, APK...): on tap, the choice
 * (download or share) comes BEFORE any download; the download follows in the
 * background, its progress under the name (\`ui/attachmentActions.ts\`).
 *
 * The protected URL (\`rc_uid\` and \`rc_token\` in the query) never leaves the
 * process: it used to be handed to \`Linking.openURL\`, so to Chrome, its
 * history and its sync, and an \`rc_token\` is worth the whole account.
 */
/** Resolve a private local file, then use exactly the existing media components. */
function NativeAttachment({c,attachment,client,maxWidth,onLongPress,quoted=false}:{c:Colors;attachment:Attachment;client:RestClient;maxWidth:number;onLongPress:(()=>void)|undefined;quoted?:boolean}){
  const source=attachment.title_link!,kind=attachment.image_url?'image':attachment.audio_url?'audio':attachment.video_url?'video':null;
  const url=protectedFileUrl(client,source);
  const [loaded,setLoaded]=useState<{url:string;local:string|null;failed:boolean}|null>(null);
  const local=loaded?.url===url?loaded.local:null,failed=loaded?.url===url&&loaded.failed;
  useEffect(()=>{
    if(!kind)return;
    let active=true;
    let attempt=0;
    const load=()=>{
      const current=++attempt;
      decryptedFile({url,title:attachment.title,type:attachment.image_type??attachment.audio_type??attachment.video_type,size:attachment.size})
        .then(value=>{if(active&&current===attempt)setLoaded({url,local:value,failed:false});},()=>{if(active&&current===attempt)setLoaded({url,local:null,failed:true});});
    };
    load();
    const stop=subscribeNativeFile(url,()=>{setLoaded({url,local:null,failed:false});load();});
    return()=>{active=false;stop();};
  },[kind,url,attachment.title,attachment.image_type,attachment.audio_type,attachment.video_type,attachment.size]);
  if(quoted&&failed)return <Text style={[styles.text,styles.italic,{color:c.dimmed}]} numberOfLines={1}>📎 {attachment.title}</Text>;
  if(!kind||failed)return <FileAttachment c={c} client={client} path={source} title={attachment.title??null} size={attachment.size??null} onLongPress={onLongPress}/>;
  if(!local)return <ActivityIndicator color={c.accent}/>;
  if(kind==='image')return <AttachedImage attachment={attachment} client={client} local={local} minWidth={quoted?QUOTED_IMAGE_WIDTH:120} maxWidth={maxWidth} minHeight={quoted?72:0} maxHeight={quoted?200:400} style={quoted?styles.quotedImage:styles.attachedImage} onLongPress={onLongPress}/>;
  if(kind==='audio')return <AudioPlayer c={c} url={local} title={attachment.title??null} onLongPress={onLongPress}/>;
  return <VideoPlayer c={c} url={local} title={attachment.title??null} onLongPress={onLongPress}/>;
}

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
  client: RestClient;
  path: string;
  title: string | null;
  size: number | null;
  onLongPress: (() => void) | undefined;
  encryption?: FileEncryption | null;
}) {
  const t = useT();
  // No MIME: \`attachments\` carries none for a file (its \`type\` is
  // "file"). The name's extension is what guides the system.
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
      <TransferBar transfer={path} c={c} />
    </Pressable>
  );
}

/** Past this, an encrypted media file is not decrypted for preview: it is shared or saved. */
const ENCRYPTED_PREVIEW_MAX = 25 * 1024 * 1024;

/**
 * Attachment of an encrypted room. The server only holds ciphertext: an
 * image, sound or video is downloaded and decrypted into the cache before
 * being shown, then renders as in plaintext. Any other file (or a media file
 * too heavy) stays a card, decrypted on share or save.
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
  client: RestClient;
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
  // Continuation from the same author: stuck to the head message (the in-group
  // gap shrinks to the paddingBottom above), gutter = tile width, taken by the
  // message's time. `lineHeight` = the body's: the time aligns with the first
  // line of text.
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
  // Width and height come from `AttachedImage`'s frame.
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
