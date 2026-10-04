/**
 * Un toast dessiné par l'app, pour iOS, qui n'en a pas de système. Android
 * garde `ToastAndroid`. Même durée que `ToastAndroid.SHORT`, sans geste à
 * faire pour le fermer, contrairement à une alerte.
 */

import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FONTS, useColors } from './theme.ts';

const DURATION_MS = 2000;

let current: { id: number; message: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const e of listeners) e();
}

export function showToast(message: string): void {
  current = { id: (current?.id ?? 0) + 1, message };
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, DURATION_MS);
  AccessibilityInfo.announceForAccessibility(message);
  emit();
}

/** Le toast de la plateforme : `ToastAndroid` sur Android, le nôtre ailleurs. */
export function notify(message: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else showToast(message);
}

function subscribe(e: () => void): () => void {
  listeners.add(e);
  return () => listeners.delete(e);
}

/** Monté une fois, au-dessus de la pile (app/_layout.tsx). */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current);
  const c = useColors();
  const insets = useSafeAreaInsets();
  if (toast === null) return null;
  return (
    <View pointerEvents="none" style={[styles.host, { bottom: insets.bottom + 72 }]}>
      <Animated.View
        key={toast.id}
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(200)}
        style={[styles.badge, { backgroundColor: c.deepCard, borderColor: c.border }]}
      >
        <Text style={[styles.text, { color: c.text }]}>{toast.message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  badge: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.45)',
  },
  text: { fontFamily: FONTS.bodySemi, fontSize: 14, textAlign: 'center' },
});
