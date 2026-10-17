/**
 * The identity stores, outside the React tree.
 *
 * Kept apart from `ui/identities.tsx`, which holds the component that FEEDS
 * them, for the same reason as [[notificationState]]: they are purged from
 * `SyncProvider`'s cleanup, and a module that imports `sync` cannot be
 * imported BY `sync` without a cycle whose resolution would depend on the
 * bundler's evaluation order. All the other stores purged at session end
 * ([[loadedRooms]], [[loadedThreads]], [[hotRooms]]) are leaves; these
 * become leaves too.
 *
 * Two stores, not one: a rename must not re-render what only concerns photos,
 * nor the reverse.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { displayNames, mentionNames, onDisplayNamesChange, statusEmojis } from '../lib/displayNames.ts';

let identities: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setIdentities(next: ReadonlyMap<string, string>): void {
  identities = next;
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Map `uid → current username`. Re-renders the caller when an identity changes. */
export function useIdentities(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => identities);
}

/** Who a username names: their uid (for the avatar), and the name to show if not the username. */
export type PersonByUsername = { uid: string | undefined; name: string | undefined };

/**
 * For what lists people by username (reactions): the uid from the identity
 * store, and the shown name, keyed by uid. A "username" that is a uid itself
 * (a private Vibez conversation's reactions) resolves as that uid, its
 * username then shown when no other name is.
 */
export function usePersonByUsername(): (username: string) => PersonByUsername {
  const known = useIdentities();
  const names = useDisplayNames();
  const uidOf = useMemo(() => new Map([...known].map(([uid, name]) => [name, uid])), [known]);
  return useCallback(
    (username: string) => {
      const uid = uidOf.get(username) ?? (known.has(username) ? username : undefined);
      if (uid === undefined) return { uid, name: undefined };
      return { uid, name: names.get(uid) ?? (uid === username ? known.get(uid) : undefined) };
    },
    [uidOf, known, names],
  );
}

/**
 * Known photo versions, indexed BOTH ways screens target an avatar: by
 * username (messages, mentions, profile, my profile) and by uid (the other
 * party of a DM, of whom often only the uid is known).
 */
export type AvatarEtags = {
  byUid: ReadonlyMap<string, string>;
  byUsername: ReadonlyMap<string, string>;
};

const NO_ETAG: AvatarEtags = { byUid: new Map(), byUsername: new Map() };
let etags: AvatarEtags = NO_ETAG;
const etagListeners = new Set<() => void>();

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Notifies only on an ACTUAL version change. The live query replays on every
 * write to `users` (a mere ingested message, then), and each
 * notification would re-render every avatar mounted on screen.
 */
export function setEtags(added: AvatarEtags): void {
  if (sameMap(etags.byUid, added.byUid) && sameMap(etags.byUsername, added.byUsername)) {
    return;
  }
  etags = added;
  for (const e of etagListeners) e();
}

function subscribeEtags(cb: () => void): () => void {
  etagListeners.add(cb);
  return () => {
    etagListeners.delete(cb);
  };
}

/**
 * Photo versions to inject into `avatarUrl`: this is what moves the URI when
 * someone changes their photo, image cache included. An avatar whose etag is
 * still unknown shows exactly as before: the URL without query stays valid.
 */
export function useAvatarEtags(): AvatarEtags {
  return useSyncExternalStore(subscribeEtags, () => etags);
}

/**
 * End of session / server switch: neither username nor photo version carries
 * over.
 *
 * `IdentityTracker` unplugs as soon as sync is no longer "ready", so nobody
 * pushes any more, and both stores kept the previous account's last value. In
 * the next session, screens served its usernames and etags until the live
 * query replayed. On the SAME server, a stale etag is worse than a stale
 * username: the avatar URL does not move, so Android's image cache serves the
 * old photo, and nothing evicts it.
 */
export function forgetIdentities(): void {
  setIdentities(new Map());
  setEtags(NO_ETAG);
}

/** `uid → name` where the server names people apart from usernames (Mattermost); empty elsewhere. */
export function useDisplayNames(): ReadonlyMap<string, string> {
  return useSyncExternalStore(onDisplayNamesChange, displayNames, displayNames);
}

/**
 * A room's shown name: a two-person DM under its peer's display name where
 * the server names people apart from usernames (Rocket.Chat's
 * `UI_Use_Real_Name`, Mattermost's name format), else the room's own.
 */
export function roomTitle(
  room: { rid: string; type: string | null; dmOtherUid: string | null; displayName: string | null; name: string | null },
  names: ReadonlyMap<string, string>,
): string {
  const peer = room.type === 'd' && room.dmOtherUid !== null ? names.get(room.dmOtherUid) : undefined;
  return peer ?? room.displayName ?? room.name ?? room.rid;
}

/** `username → name` for mentions (Mattermost); empty elsewhere. */
export function useMentionNames(): ReadonlyMap<string, string> {
  return useSyncExternalStore(onDisplayNamesChange, mentionNames, mentionNames);
}

/** `uid → custom status emoji` (Mattermost); empty elsewhere. */
export function useStatusEmojis(): ReadonlyMap<string, string> {
  return useSyncExternalStore(onDisplayNamesChange, statusEmojis, statusEmojis);
}
