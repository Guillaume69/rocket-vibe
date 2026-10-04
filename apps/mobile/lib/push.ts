import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { FcmToken } from '../modules/fcm-token/index.ts';

/**
 * Obtention du jeton FCM **natif** — pas le jeton Expo Push.
 *
 * Sous Android, `getDevicePushTokenAsync()` renvoie le jeton FCM brut, exploitable par un
 * serveur tiers : c'est lui que Rocket.Chat attend dans `POST /api/v1/push.token`
 * (`type: 'gcm'`, nommage historique, la valeur est bien un jeton FCM v1).
 * `getExpoPushTokenAsync()` passerait par le service Expo Push — exclu, on veut
 * l'autonomie complète.
 *
 * Sous iOS, `getDevicePushTokenAsync()` rend le jeton APNs, que FCM refuse :
 * `modules/fcm-token` le remet à Firebase et rend le jeton FCM. Rocket.Chat le
 * reçoit en `gcm` comme sous Android ; FCM relaie vers APNs.
 *
 * L'ordre importe : le canal de notification doit exister **avant** la demande
 * de permission, sinon le prompt `POST_NOTIFICATIONS` (Android 13+) ne
 * s'affiche jamais.
 */

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'permission-denied' | 'failed'; detail?: string };

/**
 * S'abonne à la ROTATION du jeton FCM et rend de quoi se désabonner.
 *
 * FCM fait tourner le jeton de sa propre initiative (réinstallation des Play
 * Services, restauration de sauvegarde, purge d'instance). Le natif reçoit
 * `onNewToken`, expo le remonte ici — mais rien ne le réenregistrait auprès de
 * Rocket.Chat : les notifications cessaient EN SILENCE jusqu'au prochain
 * démarrage à froid, et l'ancien jeton, lui, restait côté serveur. Un jeton
 * vide ne se propage pas : ce serait remplacer un enregistrement valide par
 * rien.
 */
export function onTokenRotation(quand: (jeton: string) => void): () => void {
  if (Platform.OS === 'ios') {
    // Deux sources : Firebase annonce un nouveau jeton FCM, et un nouveau jeton
    // APNs doit lui être remis pour qu'il en produise un.
    const fcm = FcmToken?.addListener('jetonRenouvele', ({ jeton }) => {
      if (jeton !== '') quand(jeton);
    });
    const apns = Notifications.addPushTokenListener((jeton) => {
      if (typeof jeton.data !== 'string' || jeton.data === '' || FcmToken === null) return;
      FcmToken.obtenir(jeton.data).then(quand, () => {});
    });
    return () => {
      fcm?.remove();
      apns.remove();
    };
  }
  const abonnement = Notifications.addPushTokenListener((jeton) => {
    if (typeof jeton.data === 'string' && jeton.data !== '') quand(jeton.data);
  });
  return () => abonnement.remove();
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
      return { ok: false, reason: 'failed', detail: `jeton vide (type=${type})` };
    }
    if (Platform.OS === 'ios') {
      if (FcmToken === null) return { ok: false, reason: 'failed', detail: 'module jeton-fcm absent' };
      return { ok: true, token: await FcmToken.obtenir(data) };
    }
    return { ok: true, token: data };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
