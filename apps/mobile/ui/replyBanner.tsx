/**
 * "Reply to …" banner above the composer: accent bar, quoted author,
 * one-line excerpt (thumbnail if the quoted message carries an image), a close button to
 * cancel. Shared by the room composer and the thread composer; the target
 * comes from the `ui/reply.ts` store.
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RestClient } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { useT } from './i18n.ts';
import { useIdentities } from './identities.tsx';
import type { ReplyTarget } from './reply.ts';
import { FONTS, type Colors } from './theme.ts';
import { Icon } from './icon.tsx';
import { useAuthorizedUri } from './authorizedImage.ts';

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
  // A private source names its author by uid: shown as the rows show it.
  const identities = useIdentities();
  const author = target.author === null ? '?' : (identities.get(target.author) ?? target.author);
  const preview = target.preview?.trim() ?? '';
  const thumbnail = useAuthorizedUri(target.previewImage === null ? null : protectedFileUrl(client, target.previewImage));
  return (
    <View style={[styles.banner, { borderTopColor: c.softBorder }]}>
      <View style={[styles.bar, { backgroundColor: c.accent }]} />
      {typeof thumbnail === 'string' && (
        <Image
          source={{ uri: thumbnail }}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      )}
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.accent }]} numberOfLines={1}>
          {target.nativeUnavailable ? t('quote.unavailable') : t('room.replyingTo', { name: author })}
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
        <Icon name="window-close" size={15} color={c.dimmed} />
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
});
