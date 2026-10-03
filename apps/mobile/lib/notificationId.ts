/**
 * L'identifiant sous lequel expo-notifications désigne une notification que
 * NOUS avons postée depuis le Kotlin (`plugins/with-fcm-deeplink.js`).
 *
 * Le service natif poste ses notifications de conversation avec
 * `notify(rid.hashCode(), …)` — pas de tag, un id dérivé du salon, pour que les
 * messages suivants du même salon complètent la même notification.
 * `Notifications.dismissNotificationAsync` attend, lui, une CHAÎNE : côté
 * Android, expo la passe à `parseNotificationIdentifier`, qui reconnaît la forme
 * `expo-notifications://foreign_notifications?[tag=…&]id=<entier>` et la traduit
 * en `NotificationManagerCompat.cancel(tag, id)`
 * (`ExpoPresentationDelegate.kt`). Sans tag, on écrit donc `?id=<hash>` et la
 * notification native est retirée — c'est le seul pont entre les deux voies.
 *
 * `hashCodeJava` reproduit `java.lang.String.hashCode` : `s[0]*31^(n-1) + …`,
 * sur les UNITÉS UTF-16 (ce que rend `charCodeAt`, comme `String.charAt` côté
 * Java) et en arithmétique 32 bits SIGNÉE qui déborde en silence. Un `rid`
 * Rocket.Chat est de l'ASCII, mais la règle est écrite pour ce qu'elle est :
 * `Math.imul` fait la multiplication 32 bits, `| 0` ramène dans le signé.
 */

/** `java.lang.String.hashCode` — entier 32 bits signé, débordement compris. */
export function hashCodeJava(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** L'identifiant expo de la notification de conversation d'un salon. */
export function identifiantNotifSalon(rid: string,scope?:{genre:string;userId:string;nativeInstanceId?:string;nativeDataEpoch?:string}): string {
  const key=scope?.genre==='rocketvibe'?`rocketvibe:${scope.nativeInstanceId}:${scope.nativeDataEpoch}:${scope.userId}:${rid}`:rid;
  return `expo-notifications://foreign_notifications?id=${hashCodeJava(key)}`;
}
