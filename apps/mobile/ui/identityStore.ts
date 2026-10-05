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

import { useSyncExternalStore } from 'react';

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
