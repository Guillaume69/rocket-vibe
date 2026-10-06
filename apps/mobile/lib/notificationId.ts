/**
 * The identifier under which expo-notifications refers to a notification WE
 * posted from Kotlin (`plugins/with-fcm-deeplink.js`).
 *
 * The native service posts its conversation notifications with
 * `notify(rid.hashCode(), ...)`: no tag, an id derived from the room, so that
 * later messages of the same room extend the same notification.
 * `Notifications.dismissNotificationAsync`, however, expects a STRING: on
 * Android, expo hands it to `parseNotificationIdentifier`, which recognises the
 * form `expo-notifications://foreign_notifications?[tag=...&]id=<integer>` and
 * translates it to `NotificationManagerCompat.cancel(tag, id)`
 * (`ExpoPresentationDelegate.kt`). With no tag, we therefore write
 * `?id=<hash>` and the native notification is removed: the only bridge
 * between the two paths.
 *
 * `hashCodeJava` reproduces `java.lang.String.hashCode`: `s[0]*31^(n-1) + ...`,
 * over UTF-16 UNITS (what `charCodeAt` returns, like `String.charAt` in Java)
 * and in SIGNED 32-bit arithmetic that overflows silently. A Rocket.Chat `rid`
 * is ASCII, but the rule is written for what it is: `Math.imul` does the
 * 32-bit multiplication, `| 0` brings it back to signed.
 */

/** `java.lang.String.hashCode`: signed 32-bit integer, overflow included. */
export function hashCodeJava(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** The expo identifier of a room's conversation notification. */
export function roomNotificationId(rid: string,scope?:{kind:string;userId:string;nativeInstanceId?:string;nativeDataEpoch?:string}): string {
  const key=scope?.kind==='rocketvibe'?`rocketvibe:${scope.nativeInstanceId}:${scope.nativeDataEpoch}:${scope.userId}:${rid}`:rid;
  return `expo-notifications://foreign_notifications?id=${hashCodeJava(key)}`;
}
