/**
 * Notifications (6.3): deep link to the room, badge consistent with unreads,
 * and content substitution for an encrypted room.
 *
 * Rocket.Chat puts in `data.ejson` a JSON carrying `rid`: that is our route.
 * The tap is listened to while running AND read again on cold start
 * (`getLastNotificationResponseAsync`), the exact "app killed, tap on the
 * notification" path.
 *
 * `Push_show_message = true` on the target server: a notification from an
 * encrypted room carries CIPHERTEXT. When the app does the displaying
 * (foreground, reconnection windows), we replace it with generic text. With
 * the app killed, the native FCM service (plugins/with-fcm-deeplink.js) shows
 * "Message chiffré" as soon as the ejson carries `messageType: 'e2e'`.
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

/** A push's room, and the server it comes from (multi-session). */
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
      // Never show the ciphertext: repost a generic text.
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

  // Tap on a notification: while running, and on cold start.
  //
  // This path serves ONLY notifications posted by expo (fallback pushes
  // without a `notification` block, or without a groupable `rid`). Native
  // message notifications (`plugins/with-fcm-deeplink.js`) open the room
  // through their own `rocketvibe://room/<rid>` deep link, routed by
  // expo-router, never going through here. On iOS, however, ALL taps come
  // through here: the notification extension stores `rid` and `host` in `ejson`.
  useEffect(() => {
    // The same response can arrive BOTH ways (the listener AND
    // `getLastNotificationResponse` at startup): route only once.
    let alreadyRouted: string | null = null;
    const open = (response: Notifications.NotificationResponse) => {
      // "Reply" on iOS is handled natively (modules/notification-reply), app in
      // the background: navigating here would put the room in front of the user
      // the next time they return to the app.
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (id === alreadyRouted) return;
      alreadyRouted = id;
      const target = notificationTarget(response.notification.request.content);
      if (target === null) return;
      // The `host` travels with the rid, as in the native deep link: several
      // sessions coexist and both push. Without it, a rid from another server
      // landed on a room screen with no row for that rid, hence on a permanent
      // activity indicator.
      router.push({
        pathname: '/room/[rid]',
        params: target.host === null ? { rid: target.rid } : { rid: target.rid, host: target.host },
      });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (last === null) return;
        open(last);
        // MANDATORY (expo-notifications docs): once the route is chosen, CLEAR the
        // response. Otherwise it persists and, replayed on a later mount (or by
        // NotificationManager's `pendingNotificationResponses` queue, never purged
        // natively), would navigate again to a STALE room: a "wrong room" on the
        // next launch.
        Notifications.clearLastNotificationResponseAsync().catch(() => {});
      })
      .catch(() => {});
    return () => sub.remove();
  }, [router]);

  if (sync.phase !== 'ready') return null;
  return <BadgeAndEncryptedTracking />;
}

/** Lives only once the database is ready: badge, removal of read ones, encrypted. */
function BadgeAndEncryptedTracking() {
  const sync = useSync();
  const base = sync.phase === 'ready' ? sync.base : null;

  const { data: subscriptionRows } = useCoalescedLiveQuery(base!.select().from(subscriptions));
  const { data: roomRows } = useCoalescedLiveQuery(base!.select().from(rooms));

  useEffect(() => {
    const total = (subscriptionRows ?? []).reduce((sum, a) => sum + a.unread, 0);
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [subscriptionRows]);

  // Room read ⇒ its notification goes away. `setAutoCancel(true)` only removes
  // it on TAP: reading #general from the icon left its three messages in the
  // status bar, and the next one was added as a fourth line, native-path
  // notifications being grouped AND cumulative. The unread counter already
  // follows the server in real time, including when ANOTHER device did the
  // reading: the least lying source available here.
  //
  // The `Set` remembers what was already removed, otherwise every re-render
  // would replay the call for all read rooms. The first pass is NOT skipped:
  // when the app opens, a room already read elsewhere may well have its
  // notification pending in the bar. Removing an absent notification is a
  // `NotificationManagerCompat.cancel` on an unknown id: no effect.
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
 * Android: the native id derives from the rid (`lib/notificationId.ts`). iOS:
 * each push is its own notification, grouped by `threadIdentifier`; the
 * room's ones are found by the `rid` the extension stored in `ejson`.
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
