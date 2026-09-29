/**
 * Un toast dessiné par l'app, pour iOS, qui n'en a pas de système. Android
 * garde `ToastAndroid`. Même durée que `ToastAndroid.SHORT`, sans geste à
 * faire pour le fermer, contrairement à une alerte.
 */

import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { POLICES, useCouleurs } from './theme.ts';

const DUREE_MS = 2000;

let courant: { id: number; message: string } | null = null;
let minuterie: ReturnType<typeof setTimeout> | null = null;
const ecouteurs = new Set<() => void>();

function notifier(): void {
  for (const e of ecouteurs) e();
}

export function afficherToast(message: string): void {
  courant = { id: (courant?.id ?? 0) + 1, message };
  if (minuterie !== null) clearTimeout(minuterie);
  minuterie = setTimeout(() => {
    courant = null;
    minuterie = null;
    notifier();
  }, DUREE_MS);
  AccessibilityInfo.announceForAccessibility(message);
  notifier();
}

/** Le toast de la plateforme : `ToastAndroid` sur Android, le nôtre ailleurs. */
export function signaler(message: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else afficherToast(message);
}

function abonner(e: () => void): () => void {
  ecouteurs.add(e);
  return () => ecouteurs.delete(e);
}

/** Monté une fois, au-dessus de la pile (app/_layout.tsx). */
export function HoteToast() {
  const toast = useSyncExternalStore(abonner, () => courant);
  const c = useCouleurs();
  const insets = useSafeAreaInsets();
  if (toast === null) return null;
  return (
    <View pointerEvents="none" style={[styles.hote, { bottom: insets.bottom + 72 }]}>
      <Animated.View
        key={toast.id}
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(200)}
        style={[styles.pastille, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}
      >
        <Text style={[styles.texte, { color: c.texte }]}>{toast.message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  hote: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  pastille: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.45)',
  },
  texte: { fontFamily: POLICES.corpsSemi, fontSize: 14, textAlign: 'center' },
});
