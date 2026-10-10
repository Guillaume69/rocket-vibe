/**
 * Playback of a video attachment (expo-video).
 *
 * In the thread we show a themed preview CARD ("aurora" banner + big play
 * button), and a tap opens the FULL-SCREEN player with native controls
 * (play/pause, scrubber, full screen), modeled on the image viewer.
 *
 * Two choices:
 *  - **The player only exists while watching.** `useVideoPlayer` creates a
 *    costly native instance; a thread can line up several videos. We mount
 *    `VideoModal` (and hence the player) only on open, and it is released on
 *    close (unmount). The card, for its part, costs nothing.
 *  - **The protected URL stays in memory.** As for images, it carries
 *    `rc_uid`/`rc_token`: never in a route param, only in a native `Modal`
 *    above the stack.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from './i18n.ts';
import { type Colors, FONTS } from './theme.ts';
import { Icon } from './icon.tsx';
import { mediaSource } from '../lib/mediaAuth.ts';

export function VideoPlayer({
  c,
  url,
  title,
  onLongPress,
  overlay,
}: {
  c: Colors;
  url: string;
  title?: string | null;
  onLongPress?: (() => void) | undefined;
  /** Rendered over the card (download progress). */
  overlay?: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={[styles.card, { borderColor: c.border }]}
        accessibilityRole="button"
        accessibilityLabel={title ? t('videoPlayer.playWithTitle', { title: title }) : t('videoPlayer.play')}
      >
        {/* Comet aurora, dimmed by a dark scrim: a touch of color
            without the card shouting. */}
        <LinearGradient
          colors={c.brandGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.mediaScrim }]} />

        <LinearGradient
          colors={c.ctaGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {/* A DRAWN triangle, not an emoji ("▶" renders orange on Android). */}
          <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
        </LinearGradient>

        <View style={styles.footer}>
          <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>
            {title ?? t('videoPlayer.video')}
          </Text>
        </View>
        {overlay}
      </Pressable>

      {open && <VideoModal c={c} url={url} title={title ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

export function VideoModal({
  c,
  url,
  title,
  onClose,
}: {
  c: Colors;
  url: string;
  title: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  // The player is born here (so on open) and dies on unmount: no native
  // instance for videos nobody watches. Immediate playback, the user tapped
  // "play".
  const source = useMemo(() => mediaSource(url), [url]);
  const player = useVideoPlayer(source, (p) => {
    p.play();
  });

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      <View style={[styles.background, { backgroundColor: c.fullScreenBackground }]}>
        <VideoView
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls
          allowsPictureInPicture={false}
        />
      </View>

      {/* Close cross, its own target above the player. */}
      <Pressable
        onPress={onClose}
        hitSlop={12}
        style={[styles.close, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
      >
        <Icon name="window-close" size={18} color={c.text} />
      </Pressable>

      {title != null && title !== '' && (
        <View style={[styles.caption, { bottom: insets.bottom + 12 }]} pointerEvents="none">
          <Text style={[styles.captionText, { color: c.text }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 240,
    maxWidth: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    marginLeft: 4, // optical centering of the triangle
  },
  footer: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 8,
  },
  label: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  // The color (`fullScreenBackground`) comes from the theme, set at render.
  background: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  captionText: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center' },
});
