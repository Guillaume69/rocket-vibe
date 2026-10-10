/**
 * Attachments WAITING to be sent, as chips above the field, like Rocket.Chat
 * web. Each chip shows a thumbnail (image, video) or an icon tile, the name,
 * the format and the size, and a close button to remove it; tapping it opens a
 * preview.
 * A voice message keeps its player, to listen back.
 * The typed text goes as the caption of the FIRST attachment (see `ui/composer.tsx`).
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import {
  AttachmentPreview,
  formatSize,
  QualityBadge,
  type PendingFile,
} from './attachmentPreview.tsx';
import { useT } from './i18n.ts';
import { fileIcon, isImage, shortFormat } from './mime.ts';
import { Icon } from './icon.tsx';
import type { SendQuality } from './attachmentQuality.ts';
import { type Colors, FONTS } from './theme.ts';

export type StagedAttachment = PendingFile & { key: number };

export function StagedAttachments({
  c,
  attachments,
  busy,
  onRemove,
  onOpen,
  quality,
  onQuality,
}: {
  c: Colors;
  attachments: StagedAttachment[];
  /** Send in progress: removal and quality choice frozen. */
  busy: boolean;
  onRemove: (key: number) => void;
  onOpen: (attachment: StagedAttachment) => void;
  /** `null` when no attachment can be shrunk. Applies to all those that can. */
  quality: SendQuality | null;
  onQuality: (quality: SendQuality) => void;
}) {
  const voice = attachments.filter((p) => p.type.startsWith('audio/'));
  const others = attachments.filter((p) => !p.type.startsWith('audio/'));
  return (
    <View>
      {voice.map((p) => (
        <AttachmentPreview
          key={p.key}
          c={c}
          file={p}
          busy={busy}
          onRemove={() => onRemove(p.key)}
        />
      ))}
      {others.length > 0 && (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.row}
          >
            {others.map((p) => (
              <Chip
                key={p.key}
                c={c}
                attachment={p}
                busy={busy}
                onRemove={() => onRemove(p.key)}
                onOpen={() => onOpen(p)}
              />
            ))}
          </ScrollView>
          {quality !== null && (
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
        </Animated.View>
      )}
    </View>
  );
}

function Chip({
  c,
  attachment,
  busy,
  onRemove,
  onOpen,
}: {
  c: Colors;
  attachment: StagedAttachment;
  busy: boolean;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  // A local video gets its first frame decoded by Android's image pipeline;
  // elsewhere (or on failure), the emoji tile.
  const [withoutThumbnail, setWithoutThumbnail] = useState(false);
  const thumbnail =
    !withoutThumbnail && (isImage(attachment.type) || attachment.type.startsWith('video/'));
  const meta = [shortFormat(attachment.name, attachment.type), formatSize(attachment.size, t)]
    .filter((x) => x !== null)
    .join(' ');

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.duration(180)}
      style={[styles.badge, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <Pressable
        onPress={onOpen}
        style={({ pressed }) => [styles.body, { opacity: pressed ? 0.7 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('attachmentPreview.preview', { name: attachment.name })}
      >
        {thumbnail ? (
          <Image
            source={{ uri: attachment.uri }}
            style={styles.thumbnail}
            resizeMode="cover"
            onError={() => setWithoutThumbnail(true)}
          />
        ) : (
          <LinearGradient
            colors={c.neutralGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.thumbnail}
          >
            <Icon name={fileIcon(attachment.type)} size={20} color={c.secondaryText} />
          </LinearGradient>
        )}
        <View style={styles.info}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1} ellipsizeMode="middle">
            {attachment.name}
          </Text>
          {meta !== '' && (
            <Text style={[styles.meta, { color: c.dimmed }]} numberOfLines={1}>
              {meta}
            </Text>
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={onRemove}
        disabled={busy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('attachmentPreview.remove')}
        style={({ pressed }) => [styles.remove, { opacity: busy ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Icon name="window-close" size={14} color={c.secondaryText} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 6,
    paddingVertical: 6,
    maxWidth: 240,
  },
  body: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  thumbnail: {
    width: 40,
    height: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  info: { flexShrink: 1, minWidth: 0, gap: 1 },
  name: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  meta: { fontFamily: FONTS.body, fontSize: 11 },
  remove: { paddingHorizontal: 10, paddingVertical: 8 },
  qualities: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
});
