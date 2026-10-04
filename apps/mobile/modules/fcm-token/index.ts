import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * Bridge to the Swift module (`ios/FcmTokenModule.swift`), autolinked by Expo from
 * `modules/`. iOS only: Android gets its FCM token straight from
 * `getDevicePushTokenAsync()`, and the module is `null` there. Importable ONLY in
 * the app: under Node, expo-modules-core does not load.
 */

type NativeFcmToken = {
  /** Hands the APNs token (hex, as expo returns it) to Firebase and returns the FCM token. */
  getToken(apnsTokenHex: string): Promise<string>;
  addListener(event: 'tokenRefreshed', when: (e: { token: string }) => void): EventSubscription;
};

export const FcmToken = requireOptionalNativeModule<NativeFcmToken>('FcmToken');
