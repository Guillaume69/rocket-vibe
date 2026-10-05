import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { FcmToken } from '../modules/fcm-token/index.ts';

/**
 * Getting the **native** FCM token, not the Expo Push token.
 *
 * On Android, `getDevicePushTokenAsync()` returns the raw FCM token, usable by
 * a third-party server: it is what Rocket.Chat expects in
 * `POST /api/v1/push.token` (`type: 'gcm'`, historical naming, the value is
 * indeed an FCM v1 token). `getExpoPushTokenAsync()` would go through the Expo
 * Push service, which is excluded: we want full autonomy.
 *
 * On iOS, `getDevicePushTokenAsync()` returns the APNs token, which FCM
 * refuses: `modules/fcm-token` hands it to Firebase and returns the FCM token.
 * Rocket.Chat receives it as `gcm` like on Android; FCM relays to APNs.
 *
 * Order matters: the notification channel must exist **before** the
 * permission request, otherwise the `POST_NOTIFICATIONS` prompt (Android 13+)
 * never shows.
 */

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'permission-denied' | 'failed'; detail?: string };

/**
 * Subscribes to FCM token ROTATION and returns the unsubscribe.
 *
 * FCM rotates the token on its own initiative (Play Services reinstall,
 * backup restore, instance purge). Native code receives `onNewToken` and expo
 * forwards it here, but nothing re-registered it with Rocket.Chat:
 * notifications stopped SILENTLY until the next cold start, while the old
 * token stayed on the server. An empty token is not propagated: that would
 * replace a valid registration with nothing.
 */
export function onTokenRotation(when: (token: string) => void): () => void {
  if (Platform.OS === 'ios') {
    // Two sources: Firebase announces a new FCM token, and a new APNs token
    // must be handed to it so it produces one.
    const fcm = FcmToken?.addListener('tokenRefreshed', ({ token }) => {
      if (token !== '') when(token);
    });
    const apns = Notifications.addPushTokenListener((token) => {
      if (typeof token.data !== 'string' || token.data === '' || FcmToken === null) return;
      FcmToken.getToken(token.data).then(when, () => {});
    });
    return () => {
      fcm?.remove();
      apns.remove();
    };
  }
  const subscription = Notifications.addPushTokenListener((token) => {
    if (typeof token.data === 'string' && token.data !== '') when(token.data);
  });
  return () => subscription.remove();
}

export async function getFcmToken(): Promise<TokenResult> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250],
      });
    }

    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      return { ok: false, reason: 'permission-denied' };
    }

    const { data, type } = await Notifications.getDevicePushTokenAsync();
    if (typeof data !== 'string' || data === '') {
      return { ok: false, reason: 'failed', detail: `empty token (type=${type})` };
    }
    if (Platform.OS === 'ios') {
      if (FcmToken === null) return { ok: false, reason: 'failed', detail: 'fcm-token module missing' };
      return { ok: true, token: await FcmToken.getToken(data) };
    }
    return { ok: true, token: data };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
