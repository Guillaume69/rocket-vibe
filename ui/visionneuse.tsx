/**
 * Visionneuse d'image plein écran (« lightbox »).
 *
 * Un toucher sur une pièce jointe image ouvre l'original en grand. Contrainte
 * clef : l'URL protégée porte `rc_uid`/`rc_token` en query (voir
 * `urlFichierProtege`). Elle ne doit JAMAIS transiter par un paramètre de route
 * expo-router — ce serait un secret dans une URL sérialisable. On la garde donc
 * en mémoire, dans l'état d'un contexte, et on l'affiche via une `Modal` native
 * de react-native : la Modal se rend dans une fenêtre au-dessus de toute la pile
 * de navigation, où qu'on monte le fournisseur.
 *
 * Une seule Modal partagée pour toute l'app : une par ligne de message
 * gaspillerait de la mémoire dans une liste qui recycle.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { POLICES, useCouleurs } from './theme.ts';

export type CibleImage = {
  /** URL absolue déjà authentifiée (rc_uid/rc_token inclus). */
  uri: string;
  largeur?: number | null;
  hauteur?: number | null;
  titre?: string | null;
};

type ContexteVisionneuse = {
  /** Ouvre l'image en plein écran. */
  ouvrir: (cible: CibleImage) => void;
};

const Contexte = createContext<ContexteVisionneuse | null>(null);

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

function ModaleImage({ cible, onFermer }: { cible: CibleImage | null; onFermer: () => void }) {
  const c = useCouleurs();
  const insets = useSafeAreaInsets();
  const { width: largeurEcran, height: hauteurEcran } = useWindowDimensions();
  const [charge, setCharge] = useState(false);

  // `contain` laisse l'Image se letterboxer elle-même dans le cadre plein
  // écran : pas besoin de calculer les dimensions finales, seulement de
  // remplir l'espace disponible.
  return (
    <Modal
      visible={cible !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Le bouton retour Android ET le geste de retour ferment la visionneuse.
      onRequestClose={onFermer}
      onShow={() => setCharge(false)}
    >
      <Pressable
        style={styles.fond}
        onPress={onFermer}
        accessibilityRole="button"
        accessibilityLabel="Fermer l'image"
      >
        {cible !== null && (
          <>
            {!charge && (
              <ActivityIndicator
                color={c.accent}
                size="large"
                style={StyleSheet.absoluteFill}
              />
            )}
            <Image
              source={{ uri: cible.uri }}
              style={{ width: largeurEcran, height: hauteurEcran }}
              resizeMode="contain"
              // Décodage pleine résolution puis mise à l'échelle GPU : sur
              // Android, `scale` reste net là où le `resize` par défaut de
              // Fresco pouvait adoucir. Sans risque ici — une seule image à la
              // fois, pas une liste qui défile.
              resizeMethod="scale"
              onLoadEnd={() => setCharge(true)}
              accessibilityLabel={cible.titre ?? 'Image'}
            />
          </>
        )}
      </Pressable>

      {/* Croix de fermeture, posée dans la zone sûre — au-dessus du fond
          tapable, mais avec sa propre cible de toucher. */}
      <Pressable
        onPress={onFermer}
        hitSlop={12}
        style={[styles.fermer, { top: insets.top + 8, backgroundColor: c.carte + 'D9' }]}
        accessibilityRole="button"
        accessibilityLabel="Fermer"
      >
        <Text style={[styles.croix, { color: c.texte }]}>✕</Text>
      </Pressable>

      {cible?.titre != null && cible.titre !== '' && (
        <View style={[styles.legende, { bottom: insets.bottom + 12 }]} pointerEvents="none">
          <Text style={[styles.legendeTexte, { color: c.texte }]} numberOfLines={2}>
            {cible.titre}
          </Text>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  fond: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // Presque opaque : une photo se regarde sur du noir, pas sur le salon.
    backgroundColor: 'rgba(4,3,10,0.94)',
  },
  fermer: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  croix: { fontFamily: POLICES.corpsFort, fontSize: 17, lineHeight: 20 },
  legende: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  legendeTexte: { fontFamily: POLICES.corps, fontSize: 13, textAlign: 'center' },
});
