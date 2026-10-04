import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * Pont du module Swift (`ios/FcmTokenModule.swift`), autolinké par Expo depuis
 * `modules/`. iOS seulement : Android obtient son jeton FCM directement par
 * `getDevicePushTokenAsync()`, et le module y vaut `null`. Importable QUE dans
 * l'app : sous Node, expo-modules-core ne se charge pas.
 */

type NativeFcmToken = {
  /** Remet le jeton APNs (hexadécimal, tel que rendu par expo) à Firebase et rend le jeton FCM. */
  getToken(apnsTokenHex: string): Promise<string>;
  addListener(event: 'tokenRefreshed', when: (e: { token: string }) => void): EventSubscription;
};

export const FcmToken = requireOptionalNativeModule<NativeFcmToken>('FcmToken');
