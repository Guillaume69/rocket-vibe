/**
 * Resolves `uid → CURRENT username` to display message authors, and
 * `who → their photo version` (`avatarETag`) to display avatars.
 *
 * Both come from the SAME table (`users`) and the same live query, but
 * feed two separate stores: a rename must not re-render what only concerns
 * photos, nor the reverse.
 *
 * The Rocket.Chat username is MUTABLE, the uid is not: `messages.authorName` is
 * only a snapshot frozen at ingestion (fallback). The `users` table, fed
 * by every message, gives the current username, including for messages posted
 * BEFORE a rename, which are not downloaded again.
 *
 * Subscribable module-level store (same pattern as `lib/profilePreload`)
 * rather than a Provider wrapping the stack: toggling a parent component when
 * the database becomes ready would REMOUNT the whole navigation tree. Here,
 * `IdentityTracker` is a sibling (like `NotificationHandler`), and
 * `MessageRow` subscribes to the store via `useSyncExternalStore`, re-rendering
 * only on an ACTUAL identity change.
 *
 * The stores themselves live in [[identityStore]], which imports nothing from
 * the tree: this file only keeps the component that FEEDS them. See there for
 * why the split is not cosmetic.
 */

import { useCoalescedLiveQuery } from './liveQuery.ts';
import { useEffect } from 'react';

import { users } from '../db/schema.ts';
import { displayNames, setDisplayNames } from '../lib/displayNames.ts';
import { setEtags, setIdentities } from './identityStore.ts';
import { useRealNames } from './realNames.ts';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';

export {
  forgetIdentities,
  useAvatarEtags,
  roomTitle,
  useDisplayNames,
  useStatusEmojis,
  useIdentities,
  type AvatarEtags,
} from './identityStore.ts';

/**
 * Feeds the store from the `users` table and the session. A sibling of
 * the stack (mounted in `_layout`), it renders nothing: it pushes into the store.
 */
export function IdentityTracker() {
  const sync = useSync();
  if (sync.phase !== 'ready') return null;
  return <Feed />;
}

function Feed() {
  const sync = useSync();
  const { state } = useSession();
  const base = sync.phase === 'ready' ? sync.base : null;
  // The session carries MY current username, refreshed on edit/resume earlier
  // than a re-ingested message: overlay it on the table (authoritative for me).
  const myUid = state.phase === 'connected' ? state.session.userId : null;
  const myUsername = state.phase === 'connected' ? state.session.username : null;
  // Rocket.Chat only: Mattermost's names come from its own source (`lib/displayNames.ts`).
  const rocketChat = state.phase === 'connected' && state.client.kind === 'rocketchat';
  const realNames = useRealNames() && rocketChat;

  const { data } = useCoalescedLiveQuery(
    base!
      .select({
        uid: users.uid,
        username: users.username,
        avatarEtag: users.avatarEtag,
        name: users.name,
      })
      .from(users),
  );

  useEffect(() => {
    const m = new Map<string, string>();
    const byUid = new Map<string, string>();
    const byUsername = new Map<string, string>();
    for (const u of data ?? []) {
      if (u.username !== null) m.set(u.uid, u.username);
      if (u.avatarEtag === null) continue;
      byUid.set(u.uid, u.avatarEtag);
      if (u.username !== null) byUsername.set(u.username, u.avatarEtag);
    }
    if (myUid !== null && myUsername !== null) m.set(myUid, myUsername);
    setIdentities(m);
    setEtags({ byUid, byUsername });
    if (!rocketChat) return;
    // The server's `UI_Use_Real_Name`: real names where known, else nothing
    // (rows fall back to the username). Set only on a real change: the live
    // query replays on every write to `users`.
    const names = new Map<string, string>();
    if (realNames) for (const u of data ?? []) if (u.name !== null && u.name !== '') names.set(u.uid, u.name);
    const shown = displayNames();
    if (names.size !== shown.size || [...names].some(([uid, name]) => shown.get(uid) !== name)) setDisplayNames(names);
  }, [data, myUid, myUsername, rocketChat, realNames]);

  return null;
}
