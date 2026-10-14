/**
 * Card for an X (Twitter) post link: the author (photo, name, @handle), the
 * text, and the post's picture or video's first image, like the post itself.
 *
 * Detected in the text (`lib/xPosts.ts`), so it shows before the server has
 * described the link, then filled from what the server collected
 * (`xPostMetas`). On a Rocket.Chat account, whose server gets nothing from
 * X, the card asks X itself (`lib/xSyndication.ts`); never on Vibez or
 * Mattermost. No WebView (ROADMAP §4.2): a tap opens the post in the X app or
 * the browser. X's images are public URLs; Vibez images go through the
 * message's private reader.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { mergeXMeta, xPostMetas, type XPostMeta } from '../lib/linkPreview.ts';
import { nativePreviewUri } from '../lib/nativePreviews.ts';
import type { RestClient } from '../lib/rest.ts';
import { detectXPosts, type XPostLink } from '../lib/xPosts.ts';
import { fetchXPost } from '../lib/xSyndication.ts';
import { openExternalLink } from './externalLink.ts';
import { useT } from './i18n.ts';
import { AvatarTile } from './kit.tsx';
import { useNativePreview } from './nativePreview.ts';
import { type Colors, availableBodyWidth, FONTS } from './theme.ts';

/** One card per X post link in `text` (nothing if none). */
export function XPosts({
  c,
  text,
  urls,
  client,
  onLongPress,
}: {
  c: Colors;
  text: string | null;
  /** `message.urls`: what the server collected about each post. */
  urls: string | null;
  client?: RestClient;
  onLongPress?: (() => void) | undefined;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const posts = useMemo(() => detectXPosts(text), [text]);
  const metas = useMemo(
    () =>
      xPostMetas(
        urls,
        client?.kind === 'vibez' ? (message, image) => nativePreviewUri(client, message, image) : undefined,
      ),
    [urls, client],
  );
  if (posts.length === 0) return null;
  const width = Math.min(availableBodyWidth(screenWidth), 360);
  return (
    <View style={styles.list}>
      {posts.map((post, i) => (
        <XPostCard
          key={`${post.id}:${i}`}
          c={c}
          post={post}
          meta={metas.get(post.id) ?? null}
          askX={client?.kind === 'rocketchat'}
          width={width}
          onLongPress={onLongPress}
        />
      ))}
    </View>
  );
}

function XPostCard({
  c,
  post,
  meta: collected,
  askX,
  width,
  onLongPress,
}: {
  c: Colors;
  post: XPostLink;
  /** `null` as long as the server has not described the post (or could not). */
  meta: XPostMeta | null;
  /** A Rocket.Chat account: the post is read from X when the server has no text. */
  askX: boolean;
  width: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const fromX = useXPost(post.id, askX && collected?.text == null);
  const meta = mergeXMeta(collected, fromX);
  const [failed, setFailed] = useState<string | null>(null);
  const image = useNativePreview(meta?.image ?? null);
  const avatar = meta?.avatar ?? (meta?.imageKind === 'avatar' ? image : null) ?? null;
  const media = meta?.imageKind === 'avatar' || !image || failed === image ? null : image;

  const handle = meta?.handle ?? post.handle;
  const name = meta?.name ?? (handle !== null ? `@${handle}` : null);
  const initial = (meta?.name ?? handle ?? 'X').trim().charAt(0).toUpperCase() || 'X';

  return (
    <Pressable
      onPress={() => openExternalLink(post.url)}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="link"
      accessibilityLabel={name !== null ? t('xPost.open', { name }) : t('xPost.openOnX')}
      style={[styles.card, { width, backgroundColor: c.card, borderColor: c.border }]}
    >
      <View style={styles.header}>
        <AvatarTile c={c} hueKey={handle ?? post.id} initial={initial} size={36} radius={18} uri={avatar} />
        <View style={styles.who}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
            {name ?? t('xPost.post')}
          </Text>
          {meta?.name != null && handle !== null && (
            <Text style={[styles.handle, { color: c.tertiaryText }]} numberOfLines={1}>
              @{handle}
            </Text>
          )}
        </View>
        <Text style={[styles.logo, { color: c.text }]} accessibilityElementsHidden importantForAccessibility="no">
          X
        </Text>
      </View>
      {meta?.text != null ? (
        <Text style={[styles.text, { color: c.text }]} numberOfLines={8}>
          {meta.text}
        </Text>
      ) : (
        <Text style={[styles.text, { color: c.secondaryText }]}>{t('xPost.openOnX')}</Text>
      )}
      {media !== null && (
        <View style={[styles.media, { backgroundColor: c.pendingImageBackground }]}>
          <Image
            source={{ uri: media }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={() => setFailed(media)}
          />
          {meta?.imageKind === 'video' && (
            <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.lightMediaScrim }]}>
              <LinearGradient colors={c.ctaGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.play}>
                {/* DRAWN triangle, not an emoji ("▶" renders orange on Android). */}
                <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
              </LinearGradient>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

/**
 * X's own answer for post `id` while `enabled`, `null` until it lands, if X
 * has no such post, or on failure (the card then keeps what it had).
 */
function useXPost(id: string, enabled: boolean): XPostMeta | null {
  const [found, setFound] = useState<{ id: string; meta: XPostMeta | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchXPost(id).then(
      (meta) => {
        if (alive) setFound({ id, meta });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id, enabled]);
  return enabled && found?.id === id ? found.meta : null;
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  card: {
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  who: { flex: 1, minWidth: 0 },
  name: { fontFamily: FONTS.bodyStrong, fontSize: 13.5, lineHeight: 18 },
  handle: { fontFamily: FONTS.body, fontSize: 12, lineHeight: 16 },
  logo: { fontFamily: FONTS.titleStrong, fontSize: 18, lineHeight: 22 },
  text: { fontFamily: FONTS.body, fontSize: 13.5, lineHeight: 19 },
  media: { aspectRatio: 16 / 9, borderRadius: 10, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    width: 0,
    height: 0,
    borderTopWidth: 10,
    borderBottomWidth: 10,
    borderLeftWidth: 16,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4, // optical recentring of the triangle
  },
});
