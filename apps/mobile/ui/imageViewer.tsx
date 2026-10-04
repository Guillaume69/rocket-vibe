/**
 * Visionneuse d'image plein écran (« lightbox ») avec zoom.
 *
 * Un toucher sur une pièce jointe image ouvre l'ORIGINAL pleine résolution
 * (voir `messageRow.tsx` : on affiche `title_link`, pas la vignette 480 px de
 * Rocket.Chat). Interactions : pincer pour zoomer, déplacer une fois zoomé,
 * double-tap pour (dé)zoomer, glisser vers le bas pour fermer.
 *
 * Contrainte clef : l'URL protégée porte `rc_uid`/`rc_token` en query. Elle ne
 * doit JAMAIS transiter par un paramètre de route expo-router — ce serait un
 * secret dans une URL sérialisable. On la garde donc en mémoire, dans l'état
 * d'un contexte, et on l'affiche via une `Modal` native de react-native : la
 * Modal se rend dans une fenêtre au-dessus de toute la pile de navigation.
 *
 * Une `Modal` est une fenêtre native SÉPARÉE : le `GestureHandlerRootView` de
 * la racine ne la couvre pas. Il en faut un DÉDIÉ à l'intérieur, sinon aucun
 * geste n'y est capté.
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

export type ImageTarget = {
  /** URL absolue déjà authentifiée (rc_uid/rc_token inclus). */
  uri: string;
  width?: number | null;
  height?: number | null;
  title?: string | null;
  /** MIME de l'image, quand le message le porte : nomme le fichier enregistré. */
  type?: string | null;
  /** Chemin serveur, sans jeton : la clé du transfert, partagée avec la ligne du message. */
  key?: string | null;
  /** Poids du fichier annoncé par le message, en octets. */
  size?: number | null;
  /** Fichier de l'appareil (pièce pas encore envoyée) : rien à télécharger. */
  local?: boolean;
};

type ViewerContext = {
  /** Ouvre l'image en plein écran. */
  open: (target: ImageTarget) => void;
};

const Context = createContext<ViewerContext | null>(null);

const ZOOM_MAX = 5;
const ZOOM_DOUBLE_TAP = 2.5;
/** Glisser au-delà de ce seuil (non zoomé) ferme la visionneuse. */
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
    throw new Error('useVisionneuse appelé hors de <VisionneuseImageProvider>.');
  }
  return context;
}

function tighten(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

function ImageModal({ target, onClose }: { target: ImageTarget | null; onClose: () => void }) {
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
        // Une visionneuse ne montre que des images : faute de MIME, le fichier
        // part quand même vers la galerie.
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

  // La Modal est réutilisée d'une image à l'autre : on remet le zoom à plat à
  // chaque ouverture, sinon la suivante s'afficherait déjà zoomée/décalée.
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
      // Non zoomé : un franc glissé vers le bas ferme ; sinon on revient au
      // centre. Zoomé : le déplacement est conservé.
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
      // Zoomé, un simple tap dézoome ; sinon il ferme.
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
      {/* La Modal est une fenêtre native séparée : son propre root de gestes. */}
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
                    source={{ uri: target.uri }}
                    style={styles.image}
                    resizeMode="contain"
                    // Décodage pleine résolution puis mise à l'échelle GPU : le
                    // zoom révèle le vrai détail. Sans risque — une seule image.
                    resizeMethod="scale"
                    onLoadEnd={() => setLoaded(true)}
                    accessibilityLabel={target.title ?? t('visionneuse.image')}
                  />
                </Animated.View>
              </GestureDetector>
            </>
          )}
        </View>

        {/* Croix de fermeture, au-dessus des gestes, avec sa propre cible. */}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={[styles.close, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
          accessibilityRole="button"
          accessibilityLabel={t('commun.fermer')}
        >
          <Text style={[styles.cross, { color: c.text }]}>✕</Text>
        </Pressable>

        {target?.local !== true && (
          <Pressable
            onPress={save}
            disabled={progress !== undefined}
            hitSlop={12}
            style={[styles.save, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
            accessibilityRole="button"
            accessibilityLabel={t('actionsMessage.enregistrer')}
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
  // La couleur (`fondPleinEcran`) vient du thème, posée au rendu.
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
