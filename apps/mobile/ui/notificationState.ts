/**
 * Notification state that lives OUTSIDE the React tree.
 *
 * A leaf module, importing nothing from `sync`/`session`, like
 * [[loadedRooms]], [[loadedThreads]] and [[hotRooms]]. Deliberately: these
 * stores are purged from `SyncProvider`'s cleanup, and a cross import would
 * make a cycle whose resolution depends on module evaluation order, hence on
 * the bundler, hence on the build mode.
 *
 * Two things live here because two things outlive unmounting:
 *
 * - the list of encrypted rooms, consulted by the global notification
 *   handler, itself installed at MODULE LOAD. It was only filled and cleared
 *   by a component that goes away with the session: the list of the account
 *   left behind stayed in memory and kept deciding the fate of the following
 *   notifications;
 * - the icon badge, set in the same place. After a logout, the icon kept the
 *   old account's unread count, indefinitely on a device that stays logged
 *   out.
 */

import * as Notifications from 'expo-notifications';

const encryptedRids = new Set<string>();

/** Is this room encrypted? Checked when a notification is shown. */
export function isRoomEncrypted(rid: string): boolean {
  return encryptedRids.has(rid);
}

/** Replaces the known list: the current account's encrypted rooms. */
export function setEncryptedRooms(rids: Iterable<string>): void {
  encryptedRids.clear();
  for (const rid of rids) encryptedRids.add(rid);
}

/** End of session / server switch: nothing from this account holds anymore. */
export function forgetNotificationState(): void {
  encryptedRids.clear();
  Notifications.setBadgeCountAsync(0).catch(() => {});
}
