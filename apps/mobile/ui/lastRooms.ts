/**
 * The room last opened on each account (`foldAccount`): a server switch goes
 * back to it rather than to the bare list. Pure, tested under Node; the store
 * lives in `ui/lastRoomStore.ts`.
 */

export type LastRooms = ReadonlyMap<string, string>;

export function readLastRooms(raw: string | null): LastRooms {
  if (raw === null) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

export function writeLastRooms(rooms: LastRooms): string {
  return JSON.stringify(Object.fromEntries(rooms));
}

/**
 * What to do with the room to reopen once the list shows `rows`: wait while the
 * list is still empty, open it when it is there (a voice channel would join
 * its session, so never), drop it otherwise.
 */
export function reopenDecision(
  rid: string,
  rows: readonly { rid: string; voice?: boolean }[],
): 'wait' | 'open' | 'drop' {
  if (rows.length === 0) return 'wait';
  const row = rows.find((r) => r.rid === rid);
  return row !== undefined && row.voice !== true ? 'open' : 'drop';
}

/** The one account a server switch asked to reopen its last room on. */
export function createReopenRequest() {
  let account: string | null = null;
  return {
    request(next: string): void {
      account = next;
    },
    room(on: string, rooms: LastRooms): string | null {
      return account === on ? (rooms.get(on) ?? null) : null;
    },
    settle(): void {
      account = null;
    },
    opened(on: string): void {
      if (account === on) account = null;
    },
  };
}
