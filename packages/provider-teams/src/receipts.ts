/**
 * Read receipts on a Teams account: how far the other members of the open
 * room read (the chat service's `consumptionhorizons`), read when the room
 * opens and every `REFRESH_MS` while it stays open. Mirrors
 * `TeamsSync::read_receipt` in the desktop core.
 */
import type { ReadReceiptSource } from '@rocket-vibe/provider-api/provider';
import type { TeamsClient } from './client.ts';
import { type TeamsDirectory, splitId } from './translate.ts';

export const REFRESH_MS = 30_000;

type Mark = { user_id: string; root_position: string };

export function teamsReadReceipts(client: Pick<TeamsClient, 'readPositions'>, directory: TeamsDirectory): ReadReceiptSource {
  const marks = new Map<string, Mark[]>();
  const listeners = new Set<() => void>();
  let state = 0;
  const read = async (rid: string) => {
    const fresh = await client.readPositions(rid).catch(() => null);
    if (fresh === null) return;
    if (JSON.stringify(marks.get(rid)) === JSON.stringify(fresh)) return;
    marks.set(rid, fresh);
    state++;
    for (const fn of listeners) fn();
  };
  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    follow(rid) {
      void read(rid);
      const timer = setInterval(() => void read(rid), REFRESH_MS);
      return () => clearInterval(timer);
    },
    reads: (rid) => marks.get(rid) ?? [],
    memberName: (uid) => directory.name(uid),
    position: (messageId) => splitId(messageId)?.server ?? null,
  };
}
