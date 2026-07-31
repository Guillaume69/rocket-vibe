import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Obtention du jeton FCM **natif** — pas le jeton Expo Push.
 *
 * `getDevicePushTokenAsync()` renvoie le jeton FCM brut, exploitable par un
 * serveur tiers : c'est lui que Rocket.Chat attend dans `POST /api/v1/push.token`
 * (`type: 'gcm'`, nommage historique, la valeur est bien un jeton FCM v1).
 * `getExpoPushTokenAsync()` passerait par le service Expo Push — exclu, on veut
 * l'autonomie complète.
 *
 * L'ordre importe : le canal de notification doit exister **avant** la demande
 * de permission, sinon le prompt `POST_NOTIFICATIONS` (Android 13+) ne
 * s'affiche jamais.
 */

export type ResultatJeton =
  | { ok: true; jeton: string }
  | { ok: false; raison: 'permission-refusee' | 'echec'; detail?: string };

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
export function surRotationJeton(quand: (jeton: string) => void): () => void {
  const abonnement = Notifications.addPushTokenListener((jeton) => {
    if (typeof jeton.data === 'string' && jeton.data !== '') quand(jeton.data);
  });
  return () => abonnement.remove();
}

export async function obtenirJetonFcm(): Promise<ResultatJeton> {
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
      return { ok: false, raison: 'permission-refusee' };
    }

    const { data, type } = await Notifications.getDevicePushTokenAsync();
    if (typeof data !== 'string' || data === '') {
      return { ok: false, raison: 'echec', detail: `jeton vide (type=${type})` };
    }
    return { ok: true, jeton: data };
  } catch (e) {
    return { ok: false, raison: 'echec', detail: e instanceof Error ? e.message : String(e) };
  }
}
