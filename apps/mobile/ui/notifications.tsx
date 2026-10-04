/**
 * Notifications (6.3) : deep link vers le salon, badge cohérent avec les
 * non-lus, et substitution du contenu d'un salon chiffré.
 *
 * Rocket.Chat met dans `data.ejson` un JSON qui porte `rid` : c'est notre
 * route. Le tap est écouté en marche ET relu au démarrage à froid
 * (`getLastNotificationResponseAsync`) — le chemin exact « app tuée, tap sur
 * la notification ».
 *
 * `Push_show_message = true` sur le serveur cible : une notification venant
 * d'un salon chiffré transporte du CIPHERTEXT. Quand c'est l'app qui affiche
 * (premier plan, fenêtres de reconnexion), on remplace par un texte
 * générique. App tuée, le service FCM natif (plugins/with-fcm-deeplink.js)
 * affiche « Message chiffré » dès que l'ejson porte `messageType: 'e2e'`.
 */

import * as Notifications from 'expo-notifications';
import { useCoalescedLiveQuery } from './liveQuery.ts';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { rooms, subscriptions } from '../db/schema.ts';
import { isRoomEncrypted, setEncryptedRooms } from './notificationState.ts';
import { roomNotificationId } from '../lib/notificationId.ts';
import { translateCurrent } from './i18n.ts';
import { useSync } from './sync.tsx';

/** Le salon d'un push, et le serveur d'où il vient (multi-session). */
type NotificationTarget = { rid: string; host: string | null };

function notificationTarget(content: Notifications.NotificationContent): NotificationTarget | null {
  const raw = (content.data as { ejson?: unknown } | null)?.ejson;
  if (typeof raw !== 'string') return null;
  try {
    const ejson = JSON.parse(raw) as { rid?: unknown; host?: unknown };
    if (typeof ejson.rid !== 'string') return null;
    return { rid: ejson.rid, host: typeof ejson.host === 'string' ? ejson.host : null };
  } catch {
    return null;
  }
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const target = notificationTarget(notification.request.content);
    if (target !== null && isRoomEncrypted(target.rid)) {
      // Ne pas afficher le ciphertext : on republie un texte générique.
      Notifications.scheduleNotificationAsync({
        content: {
          title: translateCurrent('notifications.encryptedTitle'),
          body: translateCurrent('notifications.encryptedBody'),
        },
        trigger: null,
      }).catch(() => {});
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

export function NotificationHandler() {
  const router = useRouter();
  const sync = useSync();

  // Tap sur une notification : en marche, et au démarrage à froid.
  //
  // Ce chemin ne dessert QUE les notifications postées par expo (pushes de
  // repli sans bloc `notification`, ou sans `rid` groupable). Les notifications
  // de message natives (`plugins/with-fcm-deeplink.js`) ouvrent le salon par
  // leur propre deep-link `rocketvibe://salon/<rid>`, routé par expo-router,
  // sans jamais passer par ici. Sous iOS, en revanche, TOUS les taps passent
  // ici : l'extension de notification range `rid` et `host` dans `ejson`.
  useEffect(() => {
    // Une même réponse peut arriver par LES DEUX voies (le listener ET
    // `getLastNotificationResponse` au démarrage) : on ne route qu'une fois.
    let alreadyRouted: string | null = null;
    const open = (response: Notifications.NotificationResponse) => {
      // « Répondre » sous iOS est traité en natif (modules/notification-reply), app
      // en arrière-plan : naviguer ici poserait le salon sous les yeux au
      // prochain retour dans l'app.
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (id === alreadyRouted) return;
      alreadyRouted = id;
      const target = notificationTarget(response.notification.request.content);
      if (target === null) return;
      // Le `host` voyage avec le rid, comme dans le deep-link natif : plusieurs
      // sessions coexistent et poussent toutes les deux. Sans lui, un rid d'un
      // autre serveur atterrissait sur un écran salon sans ligne pour ce rid,
      // donc sur un indicateur d'activité définitif.
      router.push({
        pathname: '/salon/[rid]',
        params: target.host === null ? { rid: target.rid } : { rid: target.rid, host: target.host },
      });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (last === null) return;
        open(last);
        // IMPÉRATIF (doc expo-notifications) : une fois la route choisie,
        // EFFACER la réponse. Sinon elle persiste et, rejouée à un montage
        // ultérieur — ou par la file `pendingNotificationResponses` de
        // NotificationManager, jamais purgée côté natif — renaviguerait vers un
        // salon PÉRIMÉ : un « mauvais salon » au lancement suivant.
        Notifications.clearLastNotificationResponseAsync().catch(() => {});
      })
      .catch(() => {});
    return () => sub.remove();
  }, [router]);

  if (sync.phase !== 'ready') return null;
  return <BadgeAndEncryptedTracking />;
}

/** Vit seulement quand la base est prête : badge, retrait des lus, chiffré. */
function BadgeAndEncryptedTracking() {
  const sync = useSync();
  const base = sync.phase === 'ready' ? sync.base : null;

  const { data: subscriptionRows } = useCoalescedLiveQuery(base!.select().from(subscriptions));
  const { data: roomRows } = useCoalescedLiveQuery(base!.select().from(rooms));

  useEffect(() => {
    const total = (subscriptionRows ?? []).reduce((sum, a) => sum + a.unread, 0);
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [subscriptionRows]);

  // Salon lu ⇒ sa notification s'en va. `setAutoCancel(true)` ne la retire qu'au
  // TAP : lire #general depuis l'icône laissait ses trois messages dans la barre
  // d'état, et le suivant s'y ajoutait en quatrième ligne — les notifications de
  // la voie native étant groupées ET cumulatives. Le compteur de non-lus suit
  // déjà le serveur en temps réel, y compris quand c'est un AUTRE appareil qui
  // a lu : c'est la source la moins menteuse dont on dispose ici.
  //
  // Le `Set` mémorise ce qui a déjà été retiré, sinon chaque re-rendu rejouerait
  // l'appel pour tous les salons lus. Le premier passage n'est PAS sauté : à
  // l'ouverture de l'app, un salon déjà lu ailleurs peut très bien avoir sa
  // notification en attente dans la barre. Retirer une notification absente est
  // un `NotificationManagerCompat.cancel` sur un id inconnu — sans effet.
  const removed = useRef(new Set<string>());
  useEffect(() => {
    const toRemove: string[] = [];
    for (const a of subscriptionRows ?? []) {
      if (a.unread > 0) {
        removed.current.delete(a.rid);
        continue;
      }
      if (removed.current.has(a.rid)) continue;
      removed.current.add(a.rid);
      toRemove.push(a.rid);
    }
    if (toRemove.length > 0) removeRoomNotifications(toRemove);
  }, [subscriptionRows]);

  useEffect(() => {
    setEncryptedRooms((roomRows ?? []).filter((s) => s.encrypted).map((s) => s.rid));
  }, [roomRows]);

  return null;
}

/**
 * Android : l'id natif dérive du rid (`lib/notificationId.ts`). iOS : chaque
 * push est sa propre notification, groupée par `threadIdentifier` ; on retrouve
 * celles du salon par le `rid` que l'extension a rangé dans `ejson`.
 */
function removeRoomNotifications(rids: string[]): void {
  if (Platform.OS !== 'ios') {
    for (const rid of rids) {
      Notifications.dismissNotificationAsync(roomNotificationId(rid)).catch(() => {});
    }
    return;
  }
  const targets = new Set(rids);
  Notifications.getPresentedNotificationsAsync()
    .then((present) => {
      for (const n of present) {
        const target = notificationTarget(n.request.content);
        if (target !== null && targets.has(target.rid)) {
          Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});
        }
      }
    })
    .catch(() => {});
}
