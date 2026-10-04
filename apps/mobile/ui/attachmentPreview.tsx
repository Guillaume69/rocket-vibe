/**
 * Preview of an attachment WAITING to be sent: the buffer before sending.
 *
 * Picking a file or finishing a recording used to send it at once. Here the
 * attachment first sits above the composer: you see it, can write a caption,
 * then send everything as ONE message, like the official app. Removing it (✕)
 * discards it without sending anything.
 *
 * Its appearance natively PUSHES the list (the composer grows, the `flex: 1`
 * list shrinks, inverted content pinned to the bottom → the last message moves
 * up). Three renderings by type: a thumbnail for an image, a REAL PLAYER for
 * audio (listen again before sending, `AudioPlayer` reused), an emoji tile for
 * any other file.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { useT } from './i18n.ts';
import { AudioPlayer } from './audioPlayer.tsx';
import type { TranslateFn } from './messages.ts';
import { fileEmoji, isImage } from './mime.ts';
import type { SendQuality } from './attachmentQuality.ts';
import { type Colors, FONTS } from './theme.ts';

export type PendingFile = {
  uri: string;
  name: string;
  /** MIME. Validated when staged and when sent, against `FileUpload_MediaTypeWhiteList`. */
  type: string;
  size: number | null;
};

export function formatSize(bytes: number | null, t: TranslateFn): string | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes < 1024) return t('attachmentPreview.bytes', { size: bytes });
  if (bytes < 1024 * 1024) return t('attachmentPreview.kilobytes', { size: Math.round(bytes / 1024) });
  return t('attachmentPreview.megabytes', { size: (bytes / 1024 / 1024).toFixed(1) });
}

export function AttachmentPreview({
  c,
  file,
  onRemove,
  busy = false,
  horizontalInset = 12,
  verticalInset,
  quality = null,
  onQuality,
}: {
  c: Colors;
  file: PendingFile;
  onRemove: () => void;
  /** Sending: removal is frozen (the file is already in flight). */
  busy?: boolean;
  /**
   * Quality choice (Reduced/Original chips), `null` when there is nothing to
   * choose (audio, document, light image, or a screen without compression).
   * The compression itself happens at SEND time, in the caller.
   */
  quality?: SendQuality | null;
  onQuality?: (quality: SendQuality) => void;
  /**
   * Horizontal inset of the card. 12 by default: in the room composer the
   * parent has no padding, so the card insets itself. When the caller is
   * already in a padded container (share screen), pass 0 to align the card
   * with the other fields.
   */
  horizontalInset?: number;
  /**
   * The card's own vertical inset. Undefined: keeps the composer spacing
   * (8/10). When several cards stack (share screen), pass 0 and let the
   * container handle spacing, otherwise the cards sit too far apart.
   */
  verticalInset?: number;
}) {
  const t = useT();
  const isImageFile = isImage(file.type);
  const isAudio = file.type.startsWith('audio/');
  const size = formatSize(file.size, t);

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(140)}
      style={[
        styles.host,
        { paddingHorizontal: horizontalInset },
        verticalInset !== undefined && { paddingVertical: verticalInset },
      ]}
    >
      {isAudio ? (
        // The voice message can be replayed BEFORE sending: the real player, not an icon.
        <View style={styles.row}>
          <View style={styles.full}>
            <AudioPlayer c={c} url={file.uri} title={t('audioPlayer.voiceMessage')} />
          </View>
          <RemoveButton c={c} onRemove={onRemove} busy={busy} />
        </View>
      ) : (
        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          {isImageFile ? (
            <Image source={{ uri: file.uri }} style={styles.thumbnail} resizeMode="cover" />
          ) : (
            <LinearGradient
              colors={c.neutralGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.thumbnail}
            >
              <Text style={styles.emoji}>{fileEmoji(file.type)}</Text>
            </LinearGradient>
          )}
          <View style={styles.info}>
            <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={[styles.meta, { color: c.dimmed }]} numberOfLines={1}>
              {isImageFile ? t('attachmentPreview.image') : file.type || t('attachmentPreview.file')}
              {size !== null ? ` · ${size}` : ''}
            </Text>
            {quality !== null && onQuality !== undefined && (
              <View style={styles.qualities}>
                {(['reduced', 'original'] as const).map((q) => (
                  <QualityBadge
                    key={q}
                    c={c}
                    which={q}
                    chosen={quality === q}
                    busy={busy}
                    onPick={onQuality}
                  />
                ))}
              </View>
            )}
          </View>
          <RemoveButton c={c} onRemove={onRemove} busy={busy} />
        </View>
      )}
    </Animated.View>
  );
}

/**
 * One of the two quality chips. Frozen while sending (`busy`): the version
 * being sent is already being prepared, changing your mind here would only be
 * a display lie.
 */
export function QualityBadge({
  c,
  which,
  chosen,
  busy,
  onPick,
}: {
  c: Colors;
  which: SendQuality;
  chosen: boolean;
  busy: boolean;
  onPick: (quality: SendQuality) => void;
}) {
  const t = useT();
  return (
    <Pressable
      onPress={() => onPick(which)}
      disabled={busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ selected: chosen }}
      accessibilityLabel={t(
        which === 'reduced'
          ? 'attachmentPreview.sendReduced'
          : 'attachmentPreview.sendOriginal',
      )}
      style={[
        styles.badge,
        {
          borderColor: chosen ? c.accent : c.border,
          backgroundColor: chosen ? c.surfaceActive : 'transparent',
          opacity: busy ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[styles.badgeText, { color: chosen ? c.text : c.dimmed }]}
        numberOfLines={1}
      >
        {t(which === 'reduced' ? 'attachmentPreview.reduced' : 'attachmentPreview.original')}
      </Text>
    </Pressable>
  );
}

function RemoveButton({
  c,
  onRemove,
  busy,
}: {
  c: Colors;
  onRemove: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Pressable
      onPress={onRemove}
      disabled={busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('attachmentPreview.remove')}
      style={({ pressed }) => [
        styles.remove,
        {
          backgroundColor: c.surfaceActive,
          borderColor: c.border,
          opacity: busy ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text style={[styles.removeGlyph, { color: c.secondaryText }]}>×</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { paddingTop: 8, paddingBottom: 10 },
  full: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    padding: 8,
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  emoji: { fontSize: 26 },
  info: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: FONTS.bodyBold, fontSize: 13.5 },
  meta: { fontFamily: FONTS.body, fontSize: 11 },
  qualities: { flexDirection: 'row', gap: 6, marginTop: 3 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  badgeText: { fontFamily: FONTS.bodySemi, fontSize: 11 },
  remove: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: { fontFamily: FONTS.bodySemi, fontSize: 20, lineHeight: 22 },
});
