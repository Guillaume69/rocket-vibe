/**
 * "Reply to …" banner above the composer: accent bar, quoted author,
 * one-line excerpt (thumbnail if the quoted message carries an image), ✕ to
 * cancel. Shared by the room composer and the thread composer; the target
 * comes from the `ui/reply.ts` store.
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RestClient } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { useT } from './i18n.ts';
import type { ReplyTarget } from './reply.ts';
import { FONTS, type Colors } from './theme.ts';

export function ReplyBanner({
  c,
  target,
  client,
  onCancel,
}: {
  c: Colors;
  target: ReplyTarget;
  /** The target server's files require `rc_uid`/`rc_token` (thumbnail). */
  client: RestClient;
  onCancel: () => void;
}) {
  const t = useT();
  const preview = target.preview?.trim() ?? '';
  return (
    <View style={[styles.banner, { borderTopColor: c.softBorder }]}>
      <View style={[styles.bar, { backgroundColor: c.accent }]} />
      {target.previewImage !== null && (
        <Image
          source={{ uri: protectedFileUrl(client, target.previewImage) }}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      )}
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.accent }]} numberOfLines={1}>
          {target.nativeUnavailable ? t('quote.unavailable') : t('room.replyingTo', { name: target.author ?? '?' })}
        </Text>
        <Text style={[styles.excerpt, { color: c.dimmed }]} numberOfLines={1}>
          {target.nativeUnavailable ? t('quote.selectionChanged') : preview !== '' ? preview : t('common.attachment')}
        </Text>
      </View>
      <Pressable
        onPress={onCancel}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('room.cancelReply')}
        style={({ pressed }) => [styles.close, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Text style={[styles.cross, { color: c.dimmed }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 2,
    borderTopWidth: 1,
  },
  bar: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  thumbnail: { width: 34, height: 34, borderRadius: 6, backgroundColor: '#00000010' },
  body: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontFamily: FONTS.bodyBold, fontSize: 12.5 },
  excerpt: { fontFamily: FONTS.body, fontSize: 13, fontStyle: 'italic' },
  close: { padding: 4 },
  cross: { fontSize: 15 },
});
