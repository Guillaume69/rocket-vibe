/**
 * Link previews in the timeline: direct image, or "unfurl" card
 * (title/description/thumbnail/site) from server metadata
 * (`lib/linkPreview.ts`). No WebView, no scraping: we project what the
 * provider already projected into `message.urls`.
 *
 * Rocket.Chat images stay public; RocketVibe previews go through the private
 * reader bound to the message, including in the viewer.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { linkPreviews, type LinkPreview } from '../lib/linkPreview.ts';
import type {RestClient} from '../lib/rest.ts';
import {nativePreviewUri} from '../lib/nativePreviews.ts';
import {useNativePreview} from './nativePreview.ts';
import { useT } from './i18n.ts';
import { openExternalLink } from './externalLink.ts';
import { type Colors, availableBodyWidth, FONTS } from './theme.ts';
import { useImageViewer } from './imageViewer.tsx';

/** Renders one preview per usable link in `urls` (nothing if none). */
export function LinkPreviews({
  c,
  urls,
  client,
  onLongPress,
}: {
  c: Colors;
  urls: string | null;
  client?:RestClient;
  onLongPress?: (() => void) | undefined;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const previews = useMemo(() => linkPreviews(urls,3,client?.kind==='rocketvibe'?(message,image)=>nativePreviewUri(client,message,image):undefined), [urls,client]);
  if (previews.length === 0) return null;

  // Same available width as attached images, see `availableBodyWidth`.
  const availableWidth = availableBodyWidth(screenWidth);

  return (
    <View style={styles.list}>
      {previews.map((preview, i) =>
        preview.type === 'image' ? (
          <ImagePreview
            key={preview.url + i}
            c={c}
            url={preview.url}
            availableWidth={availableWidth}
            onLongPress={onLongPress}
          />
        ) : (
          <CardPreview
            key={preview.url + i}
            c={c}
            preview={preview}
            availableWidth={availableWidth}
            onLongPress={onLongPress}
          />
        ),
      )}
    </View>
  );
}

/** A link that IS an image: shown, tappable to enlarge. */
function ImagePreview({
  c,
  url,
  availableWidth,
  onLongPress,
}: {
  c: Colors;
  url: string;
  availableWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const viewer = useImageViewer();
  const [measure, setMeasure] = useState<{ uri:string; w: number; h: number } | null>(null);
  const [error, setError] = useState<string|null>(null);
  const local=useNativePreview(url),native=url.startsWith('rv-preview:');
  const dims=measure?.uri===local?measure:null;

  useEffect(() => {
    let alive = true;
    if(!local)return()=>{alive=false;};
    Image.getSize(
      local,
      (w, h) => {
        if (alive) setMeasure({ uri:local,w, h });
      },
      () => {
        if (alive) setError(local);
      },
    );
    return () => {
      alive = false;
    };
  }, [local]);

  // A broken image link (404, unreachable host) leaves nothing on screen.
  if (error===local || native&&!local) return null;

  // No upscaling past the native size; a floor to stay tappable. Default
  // ratio until the real dimensions are known.
  const width = Math.max(Math.min(dims?.w ?? availableWidth, availableWidth), 120);
  const ratio = dims ? dims.h / Math.max(dims.w, 1) : 0.66;
  const height = Math.min(Math.round(width * ratio), 400);

  return (
    <Pressable
      onPress={() =>
        local&&viewer.open({ uri: native?url:local, width: dims?.w ?? null, height: dims?.h ?? null, title: null,type:native?'image/png':null })
      }
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="imagebutton"
      accessibilityLabel={t('linkCard.imageEnlarge')}
      style={{ width, height }}
    >
      {dims === null ? (
        <View
          style={[
            styles.imagePending,
            { width, height, backgroundColor: c.pendingImageBackground },
          ]}
        >
          <ActivityIndicator />
        </View>
      ) : (
        <Image
          source={local?{ uri: local }:undefined}
          style={[
            styles.image,
            { width, height, backgroundColor: c.pendingImageBackground },
          ]}
          resizeMode="cover"
          onError={() => setError(local??null)}
        />
      )}
    </Pressable>
  );
}

/** "Unfurl" card: optional banner + site + title + description. */
function CardPreview({
  c,
  preview,
  availableWidth,
  onLongPress,
}: {
  c: Colors;
  preview: Extract<LinkPreview, { type: 'card' }>;
  availableWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const [imageError, setImageError] = useState<string|null>(null);
  const local=useNativePreview(preview.image);
  const showsBanner = !!local && imageError!==local;
  const accessibleName = preview.title ?? preview.site ?? t('linkCard.defaultLink');

  return (
    <Pressable
      onPress={() => openExternalLink(preview.url)}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="link"
      accessibilityLabel={t('linkCard.open', { name: accessibleName })}
      style={[styles.card, { width: availableWidth, backgroundColor: c.card, borderColor: c.border }]}
    >
      {showsBanner && (
        <Image
          source={{ uri: local! }}
          style={[styles.banner, { backgroundColor: c.pendingImageBackground }]}
          resizeMode="cover"
            onError={() => setImageError(local??null)}
        />
      )}
      <View style={styles.cardText}>
        {preview.site !== null && (
          <Text style={[styles.site, { color: c.cyan }]} numberOfLines={1}>
            {preview.site}
          </Text>
        )}
        {preview.title !== null && (
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {preview.title}
          </Text>
        )}
        {preview.description !== null && (
          <Text style={[styles.description, { color: c.secondaryText }]} numberOfLines={2}>
            {preview.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  // Placeholder backgrounds (`pendingImageBackground`) come from the theme, set at render.
  image: { borderRadius: 10 },
  imagePending: {
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  banner: {
    width: '100%',
    aspectRatio: 1.91, // ratio OpenGraph standard
  },
  cardText: { paddingHorizontal: 12, paddingVertical: 10, gap: 3 },
  site: { fontFamily: FONTS.bodySemi, fontSize: 11, letterSpacing: 0.3 },
  title: { fontFamily: FONTS.bodyStrong, fontSize: 13.5, lineHeight: 18 },
  description: { fontFamily: FONTS.body, fontSize: 12.5, lineHeight: 17 },
});
