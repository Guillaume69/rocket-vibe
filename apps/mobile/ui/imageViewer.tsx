/**
 * Full-screen image viewer ("lightbox") with zoom.
 *
 * A tap on an image attachment opens the full-resolution ORIGINAL (see
 * `messageRow.tsx`: `title_link` is shown, not Rocket.Chat's 480 px
 * thumbnail). Interactions: pinch to zoom, pan once zoomed, double-tap to
 * zoom in/out, swipe down to close.
 *
 * Key constraint: the protected URL carries `rc_uid`/`rc_token` in its query.
 * It must NEVER go through an expo-router route param: that would be a secret
 * in a serialisable URL. So it is kept in memory, in a context's state, and
 * shown through a react-native native `Modal`: the Modal renders in a window
 * above the whole navigation stack.
 *
 * A `Modal` is a SEPARATE native window: the root `GestureHandlerRootView`
 * does not cover it. It needs a DEDICATED one inside, otherwise no gesture is
 * caught there.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { saveInBackground } from './attachmentActions.ts';
import { useT } from './i18n.ts';
import { FONTS, useColors } from './theme.ts';
import { progressLabel, useProgress } from './transfers.ts';
import {useNativePreview} from './nativePreview.ts';
import { useAuthorizedUri } from './authorizedImage.ts';

export type ImageTarget = {
  /** Absolute, already authenticated URL (rc_uid/rc_token included). */
  uri: string;
  width?: number | null;
  height?: number | null;
  title?: string | null;
  /** The image's MIME, when the message carries it: names the saved file. */
  type?: string | null;
  /** Server path, without token: the transfer key, shared with the message row. */
  key?: string | null;
  /** File size announced by the message, in bytes. */
  size?: number | null;
  /** Device file (attachment not sent yet): nothing to download. */
  local?: boolean;
};

type ViewerContext = {
  /** Opens the image full screen. */
  open: (target: ImageTarget) => void;
};

const Context = createContext<ViewerContext | null>(null);

const ZOOM_MAX = 5;
const ZOOM_DOUBLE_TAP = 2.5;
/** Swiping past this threshold (unzoomed) closes the viewer. */
const CLOSE_THRESHOLD = 120;

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<ImageTarget | null>(null);
  const open = useCallback((c: ImageTarget) => setTarget(c), []);
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <Context.Provider value={value}>
      {children}
      <ImageModal target={target} onClose={close} />
    </Context.Provider>
  );
}

export function useImageViewer(): ViewerContext {
  const context = useContext(Context);
  if (context === null) {
    throw new Error('useImageViewer called outside <ImageViewerProvider>.');
  }
  return context;
}

function tighten(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

function ImageModal({ target, onClose }: { target: ImageTarget | null; onClose: () => void }) {
  const imageUri=useAuthorizedUri(useNativePreview(target?.uri));
  const t = useT();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState(false);
  const transferKey = target === null ? null : (target.key ?? target.uri);
  const progress = useProgress(transferKey);

  const save = () => {
    if (target === null || transferKey === null) return;
    saveInBackground(
      {
        key: transferKey,
        url: target.uri,
        title: target.title ?? null,
        // A viewer only shows images: without a MIME, the file still goes to the gallery.
        type: target.type ?? 'image/jpeg',
        size: target.size ?? null,
      },
      t,
    );
  };

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const xMem = useSharedValue(0);
  const yMem = useSharedValue(0);

  // The Modal is reused from one image to the next: reset the zoom on each
  // open, otherwise the next one would show already zoomed/offset.
  useEffect(() => {
    if (target !== null) {
      scale.value = 1;
      savedScale.value = 1;
      x.value = 0;
      y.value = 0;
      xMem.value = 0;
      yMem.value = 0;
      setLoaded(false);
    }
  }, [target, scale, savedScale, x, y, xMem, yMem]);

  const flatten = useCallback(() => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    x.value = withTiming(0);
    y.value = withTiming(0);
    xMem.value = 0;
    yMem.value = 0;
  }, [scale, savedScale, x, y, xMem, yMem]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = tighten(savedScale.value * e.scale, 0.9, ZOOM_MAX);
    })
    .onEnd(() => {
      if (scale.value <= 1) flatten();
      else savedScale.value = scale.value;
    });

  const move = Gesture.Pan()
    .onUpdate((e) => {
      x.value = xMem.value + e.translationX;
      y.value = yMem.value + e.translationY;
    })
    .onEnd((e) => {
      // Unzoomed: a firm swipe down closes; otherwise snap back to the centre.
      // Zoomed: the offset is kept.
      if (scale.value <= 1) {
        if (e.translationY > CLOSE_THRESHOLD) {
          runOnJS(onClose)();
        } else {
          x.value = withTiming(0);
          y.value = withTiming(0);
        }
      } else {
        xMem.value = x.value;
        yMem.value = y.value;
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        flatten();
      } else {
        scale.value = withTiming(ZOOM_DOUBLE_TAP);
        savedScale.value = ZOOM_DOUBLE_TAP;
      }
    });

  const simpleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      // Zoomed, a single tap zooms out; otherwise it closes.
      if (scale.value > 1) flatten();
      else runOnJS(onClose)();
    });

  const gestures = Gesture.Race(
    Gesture.Simultaneous(pinch, move),
    Gesture.Exclusive(doubleTap, simpleTap),
  );

  const styleImage = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* The Modal is a separate native window: its own gesture root. */}
      <GestureHandlerRootView style={styles.root}>
        <View style={[styles.background, { backgroundColor: c.fullScreenBackground }]}>
          {target !== null && (
            <>
              {!loaded && (
                <ActivityIndicator color={c.accent} size="large" style={StyleSheet.absoluteFill} />
              )}
              <GestureDetector gesture={gestures}>
                <Animated.View style={[styles.frame, styleImage]}>
                  <Image
                    source={imageUri?{ uri: imageUri }:undefined}
                    style={styles.image}
                    resizeMode="contain"
                    // Full-resolution decode then GPU scaling: zoom reveals real detail. Safe:
                    // a single image.
                    resizeMethod="scale"
                    onLoadEnd={() => setLoaded(true)}
                    accessibilityLabel={target.title ?? t('viewer.image')}
                  />
                </Animated.View>
              </GestureDetector>
            </>
          )}
        </View>

        {/* Close cross, above the gestures, with its own target. */}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={[styles.close, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Text style={[styles.cross, { color: c.text }]}>✕</Text>
        </Pressable>

        {target?.local !== true && (
          <Pressable
            onPress={save}
            disabled={progress !== undefined || !!target?.uri.startsWith('rv-preview:')&&!imageUri}
            hitSlop={12}
            style={[styles.save, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
            accessibilityRole="button"
            accessibilityLabel={t('messageActions.save')}
          >
            {progress === undefined ? (
              <Text style={[styles.cross, { color: c.text }]}>⤓</Text>
            ) : (
              <Text style={[styles.percentage, { color: c.text }]}>
                {progressLabel(progress)}
              </Text>
            )}
          </Pressable>
        )}

        {target?.title != null && target.title !== '' && (
          <View style={[styles.caption, { bottom: insets.bottom + 12 }]} pointerEvents="none">
            <Text style={[styles.captionText, { color: c.text }]} numberOfLines={2}>
              {target.title}
            </Text>
          </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The colour (`fullScreenBackground`) comes from the theme, set at render.
  background: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: '100%', height: '100%' },
  image: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  save: {
    position: 'absolute',
    right: 62,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  percentage: { fontFamily: FONTS.bodySemi, fontSize: 11 },
  cross: { fontFamily: FONTS.bodyStrong, fontSize: 17, lineHeight: 20 },
  caption: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  captionText: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center' },
});
