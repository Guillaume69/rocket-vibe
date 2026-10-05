/**
 * Preview card for an "embed" video link (YouTube, Dailymotion, Vimeo).
 *
 * Truly embedded playback would require a WebView (forbidden outside the
 * call screen, ROADMAP §4.2): we thus show a card in the same language as
 * the local video card (public thumbnail as banner, dark scrim, gradient play
 * button, and a footer carrying the video's title and channel when the server
 * harvested them (`videoMetas`)). A tap OPENS the native app
 * (YouTube/Dailymotion) or the browser through `Linking`. No WebView, no
 * stream to extract.
 *
 * Rocket.Chat thumbnails stay public. RocketVibe uses the message's private
 * image, through the same reader as article cards. Without an available image,
 * the "aurora" gradient banner stays the existing fallback.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { videoMetas, type VideoMeta } from '../lib/linkPreview.ts';
import type {RestClient} from '../lib/rest.ts';
import {nativePreviewUri} from '../lib/nativePreviews.ts';
import {useNativePreview} from './nativePreview.ts';
import { detectVideoLinks, type VideoLink } from '../lib/videoLinks.ts';
import { useT } from './i18n.ts';
import { openExternalLink } from './externalLink.ts';
import { type Colors, FONTS } from './theme.ts';

/** Renders one card per video link detected in `text` (nothing if none). */
export function EmbedLinks({
  c,
  text,
  urls,
  client,
  onLongPress,
}: {
  c: Colors;
  text: string | null;
  /** `message.urls`: the video title is there, harvested by the server. */
  urls: string | null;
  client?:RestClient;
  onLongPress?: (() => void) | undefined;
}) {
  const links = useMemo(() => detectVideoLinks(text), [text]);
  const metas = useMemo(() => videoMetas(urls,client?.kind==='rocketvibe'?(message,image)=>nativePreviewUri(client,message,image):undefined), [urls,client]);
  if (links.length === 0) return null;
  return (
    <View style={styles.list}>
      {links.map((link, i) => (
        <EmbedCard
          key={`${link.provider}:${link.id}:${i}`}
          c={c}
          link={link}
          meta={metas.get(link.id) ?? null}
          native={client?.kind==='rocketvibe'}
          onLongPress={onLongPress}
        />
      ))}
    </View>
  );
}

function EmbedCard({
  c,
  link,
  meta,
  native,
  onLongPress,
}: {
  c: Colors;
  link: VideoLink;
  /** `null` as long as the server has not described the link (yet). */
  meta: VideoMeta | null;
  native:boolean;
  onLongPress?: (() => void) | undefined;
}) {
  const t = useT();
  const [thumbnailError, setThumbnailError] = useState<string|null>(null);
  const image=useNativePreview(native?meta?.image??null:link.thumbnail);
  const showsThumbnail = !!image && thumbnailError!==image;

  const title = meta?.title ?? null;

  return (
    <Pressable
      onPress={() => openExternalLink(link.url)}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={[styles.card, { borderColor: c.border, backgroundColor: c.pendingImageBackground }]}
      accessibilityRole="button"
      accessibilityLabel={t('embedCard.open', { name: title ?? link.name })}
    >
      <View style={styles.media}>
      {showsThumbnail ? (
        <Image
          source={{ uri: image! }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setThumbnailError(image??null)}
        />
      ) : (
        <LinearGradient
          colors={c.brandGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {/* Scrim: contrast so the button and label stand out on any
          thumbnail. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.lightMediaScrim }]} />

      <LinearGradient
        colors={c.ctaGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.button}
      >
        {/* DRAWN triangle, not an emoji ("▶" renders orange on Android). */}
        <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
      </LinearGradient>
      </View>

      <View style={[styles.footer, { backgroundColor: c.card }]}>
        {title !== null && (
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {title}
          </Text>
        )}
        <View style={styles.sourceRow}>
          <View style={[styles.triangleMini, { borderLeftColor: c.tertiaryText }]} />
          <Text style={[styles.name, { color: c.tertiaryText }]} numberOfLines={1}>
            {meta?.author != null ? `${link.name} · ${meta.author}` : link.name}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  // The colours (`pendingImageBackground`, `lightMediaScrim`) come from the theme.
  card: {
    width: 240,
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  media: { aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' },
  button: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    width: 0,
    height: 0,
    borderTopWidth: 11,
    borderBottomWidth: 11,
    borderLeftWidth: 18,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4, // optical recentring of the triangle
  },
  footer: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: FONTS.bodySemi, fontSize: 13, lineHeight: 17 },
  triangleMini: {
    width: 0,
    height: 0,
    borderTopWidth: 4,
    borderBottomWidth: 4,
    borderLeftWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  name: { fontFamily: FONTS.body, fontSize: 11, flexShrink: 1 },
});
