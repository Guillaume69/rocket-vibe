/**
 * React read of presence (8.4). `useSyncExternalStore`: the engine is a
 * volatile external store, no SQLite, no live query.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { PresenceStatus } from '../lib/presence.ts';
import type { TranslationKey } from './messages.ts';
import { useSync } from './sync.tsx';
import type { Colors } from './theme.ts';

const NOTHING = () => {};

/**
 * Presence dots, fed by the THEME TOKENS: the app's only status → colour
 * table (the audit found three, with three different shades for the same
 * status).
 */
export function presenceColors(c: Colors): Record<PresenceStatus, string> {
  return { online: c.online, away: c.absent, busy: c.danger, offline: c.offline };
}

/**
 * Labels per status: four `common.presence*` keys for the whole app, in
 * lowercase; casing for a context ("Online" in a picker) is up to the
 * caller.
 */
export const PRESENCE_KEYS: Record<PresenceStatus, TranslationKey> = {
  online: 'common.presenceOnline',
  away: 'common.presenceAway',
  busy: 'common.presenceBusy',
  offline: 'common.presenceOffline',
};

/**
 * A user's status, `null` if unknown: the caller then shows NOTHING
 * (degradation: beyond ~200 connections the server stops broadcasting, and
 * the UI must never depend on it).
 */
export function usePresence(uid: string | null,roomId?:string): PresenceStatus | null {
  const sync = useSync();
  const presence = sync.phase === 'ready' ? sync.presence : null;
  const native=sync.phase==='ready'?sync.provider.native?.chat.live:undefined;

  // STABLE identities: a `subscribe` recreated on every render would
  // unsubscribe/resubscribe every row on every list re-render. And a row
  // without a uid (channel) does not subscribe at all, otherwise every
  // presence event would wake every visible row.
  const subscribe = useCallback(
    (reread: () => void) =>
      native && roomId?native.subscribe(reread):presence === null || uid === null ? NOTHING : presence.onChange(reread),
    [presence, uid,native,roomId],
  );
  const read = useCallback(
    () => {
      if(native && roomId){
        const state=native.state,peer=state?.rooms.find(r=>r.room_id===roomId)?.direct_peer;
        return peer?state?.presence.find(p=>p.user.id===peer.id)?.status??'offline':null;
      }
      return uid === null || presence === null ? null : presence.statusOf(uid);
    },
    [presence, uid,native,roomId],
  );
  return useSyncExternalStore(subscribe, read);
}

// The OTHER participant of a DM is NOT DERIVED from the rid: on 8.5 a DM's
// rid is a random ObjectId, no longer the concatenation of both uids
// (checked on the local server). It comes from the Rooms document (`uids`)
// and lives in the `rooms.dm_other_uid` column; see `toRoom`.
