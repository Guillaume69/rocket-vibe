/**
 * Visionneuse d'image plein écran (« lightbox ») avec zoom.
 *
 * Un toucher sur une pièce jointe image ouvre l'ORIGINAL pleine résolution
 * (voir `ligneMessage.tsx` : on affiche `title_link`, pas la vignette 480 px de
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

import { enregistrerEnFond } from './actionsJointe.ts';
import { useT } from './i18n.ts';
import { POLICES, useCouleurs } from './theme.ts';
import { libelleProgression, useProgression } from './transferts.ts';

export type CibleImage = {
  /** URL absolue déjà authentifiée (rc_uid/rc_token inclus). */
  uri: string;
  largeur?: number | null;
  hauteur?: number | null;
  titre?: string | null;
  /** MIME de l'image, quand le message le porte : nomme le fichier enregistré. */
  type?: string | null;
  /** Chemin serveur, sans jeton : la clé du transfert, partagée avec la ligne du message. */
  cle?: string | null;
  /** Poids du fichier annoncé par le message, en octets. */
  taille?: number | null;
  /** Fichier de l'appareil (pièce pas encore envoyée) : rien à télécharger. */
  local?: boolean;
};

type ContexteVisionneuse = {
  /** Ouvre l'image en plein écran. */
  ouvrir: (cible: CibleImage) => void;
};

const Contexte = createContext<ContexteVisionneuse | null>(null);

const ZOOM_MAX = 5;
const ZOOM_DOUBLE_TAP = 2.5;
/** Glisser au-delà de ce seuil (non zoomé) ferme la visionneuse. */
const SEUIL_FERMETURE = 120;

export function VisionneuseImageProvider({ children }: { children: React.ReactNode }) {
  const [cible, setCible] = useState<CibleImage | null>(null);
  const ouvrir = useCallback((c: CibleImage) => setCible(c), []);
  const fermer = useCallback(() => setCible(null), []);
  const valeur = useMemo(() => ({ ouvrir }), [ouvrir]);

  return (
    <Contexte.Provider value={valeur}>
      {children}
      <ModaleImage cible={cible} onFermer={fermer} />
    </Contexte.Provider>
  );
}

export function useVisionneuse(): ContexteVisionneuse {
  const contexte = useContext(Contexte);
  if (contexte === null) {
    throw new Error('useVisionneuse appelé hors de <VisionneuseImageProvider>.');
  }
  return contexte;
}

function serrer(valeur: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(valeur, min), max);
}

function ModaleImage({ cible, onFermer }: { cible: CibleImage | null; onFermer: () => void }) {
  const t = useT();
  const c = useCouleurs();
  const insets = useSafeAreaInsets();
  const [charge, setCharge] = useState(false);
  const cleTransfert = cible === null ? null : (cible.cle ?? cible.uri);
  const progression = useProgression(cleTransfert);

  const enregistrer = () => {
    if (cible === null || cleTransfert === null) return;
    enregistrerEnFond(
      {
        cle: cleTransfert,
        url: cible.uri,
        titre: cible.titre ?? null,
        // Une visionneuse ne montre que des images : faute de MIME, le fichier
        // part quand même vers la galerie.
        type: cible.type ?? 'image/jpeg',
        taille: cible.taille ?? null,
      },
      t,
    );
  };

  const echelle = useSharedValue(1);
  const echelleMem = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const xMem = useSharedValue(0);
  const yMem = useSharedValue(0);

  // La Modal est réutilisée d'une image à l'autre : on remet le zoom à plat à
  // chaque ouverture, sinon la suivante s'afficherait déjà zoomée/décalée.
  useEffect(() => {
    if (cible !== null) {
      echelle.value = 1;
      echelleMem.value = 1;
      x.value = 0;
      y.value = 0;
      xMem.value = 0;
      yMem.value = 0;
      setCharge(false);
    }
  }, [cible, echelle, echelleMem, x, y, xMem, yMem]);

  const remettreAPlat = useCallback(() => {
    'worklet';
    echelle.value = withTiming(1);
    echelleMem.value = 1;
    x.value = withTiming(0);
    y.value = withTiming(0);
    xMem.value = 0;
    yMem.value = 0;
  }, [echelle, echelleMem, x, y, xMem, yMem]);

  const pincer = Gesture.Pinch()
    .onUpdate((e) => {
      echelle.value = serrer(echelleMem.value * e.scale, 0.9, ZOOM_MAX);
    })
    .onEnd(() => {
      if (echelle.value <= 1) remettreAPlat();
      else echelleMem.value = echelle.value;
    });

  const deplacer = Gesture.Pan()
    .onUpdate((e) => {
      x.value = xMem.value + e.translationX;
      y.value = yMem.value + e.translationY;
    })
    .onEnd((e) => {
      // Non zoomé : un franc glissé vers le bas ferme ; sinon on revient au
      // centre. Zoomé : le déplacement est conservé.
      if (echelle.value <= 1) {
        if (e.translationY > SEUIL_FERMETURE) {
          runOnJS(onFermer)();
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
      if (echelle.value > 1) {
        remettreAPlat();
      } else {
        echelle.value = withTiming(ZOOM_DOUBLE_TAP);
        echelleMem.value = ZOOM_DOUBLE_TAP;
      }
    });

  const simpleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      // Zoomé, un simple tap dézoome ; sinon il ferme.
      if (echelle.value > 1) remettreAPlat();
      else runOnJS(onFermer)();
    });

  const gestes = Gesture.Race(
    Gesture.Simultaneous(pincer, deplacer),
    Gesture.Exclusive(doubleTap, simpleTap),
  );

  const styleImage = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: echelle.value }],
  }));

  return (
    <Modal
      visible={cible !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onFermer}
    >
      {/* La Modal est une fenêtre native séparée : son propre root de gestes. */}
      <GestureHandlerRootView style={styles.racine}>
        <View style={[styles.fond, { backgroundColor: c.fondPleinEcran }]}>
          {cible !== null && (
            <>
              {!charge && (
                <ActivityIndicator color={c.accent} size="large" style={StyleSheet.absoluteFill} />
              )}
              <GestureDetector gesture={gestes}>
                <Animated.View style={[styles.cadre, styleImage]}>
                  <Image
                    source={{ uri: cible.uri }}
                    style={styles.image}
                    resizeMode="contain"
                    // Décodage pleine résolution puis mise à l'échelle GPU : le
                    // zoom révèle le vrai détail. Sans risque — une seule image.
                    resizeMethod="scale"
                    onLoadEnd={() => setCharge(true)}
                    accessibilityLabel={cible.titre ?? t('visionneuse.image')}
                  />
                </Animated.View>
              </GestureDetector>
            </>
          )}
        </View>

        {/* Croix de fermeture, au-dessus des gestes, avec sa propre cible. */}
        <Pressable
          onPress={onFermer}
          hitSlop={12}
          style={[styles.fermer, { top: insets.top + 8, backgroundColor: c.carte + 'D9' }]}
          accessibilityRole="button"
          accessibilityLabel={t('commun.fermer')}
        >
          <Text style={[styles.croix, { color: c.texte }]}>✕</Text>
        </Pressable>

        {cible?.local !== true && (
          <Pressable
            onPress={enregistrer}
            disabled={progression !== undefined}
            hitSlop={12}
            style={[styles.enregistrer, { top: insets.top + 8, backgroundColor: c.carte + 'D9' }]}
            accessibilityRole="button"
            accessibilityLabel={t('actionsMessage.enregistrer')}
          >
            {progression === undefined ? (
              <Text style={[styles.croix, { color: c.texte }]}>⤓</Text>
            ) : (
              <Text style={[styles.pourcentage, { color: c.texte }]}>
                {libelleProgression(progression)}
              </Text>
            )}
          </Pressable>
        )}

        {cible?.titre != null && cible.titre !== '' && (
          <View style={[styles.legende, { bottom: insets.bottom + 12 }]} pointerEvents="none">
            <Text style={[styles.legendeTexte, { color: c.texte }]} numberOfLines={2}>
              {cible.titre}
            </Text>
          </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  racine: { flex: 1 },
  // La couleur (`fondPleinEcran`) vient du thème, posée au rendu.
  fond: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cadre: { width: '100%', height: '100%' },
  image: { width: '100%', height: '100%' },
  fermer: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enregistrer: {
    position: 'absolute',
    right: 62,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pourcentage: { fontFamily: POLICES.corpsSemi, fontSize: 11 },
  croix: { fontFamily: POLICES.corpsFort, fontSize: 17, lineHeight: 20 },
  legende: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  legendeTexte: { fontFamily: POLICES.corps, fontSize: 13, textAlign: 'center' },
});
