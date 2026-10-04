/**
 * Pinned and favourite (starred) messages.
 *
 * `starred` arrives as `[{_id: uid}, ...]`: only the uids are kept, and
 * "starred by me" is decided on read, with the session's uid, like reactions,
 * judged by username at display time.
 *
 * `chat.pinMessage` does NOT broadcast the pinned message on
 * `stream-room-messages` (probed on 8.5: only the `message_pinned` system
 * message arrives; `unPin` does broadcast). Local state is therefore set by
 * hand after each successful action (`starredAfter`, `Store.updateMessageMarks`).
 */

/** Raw `starred` → serialized uids, `null` if nobody. */
export function starredIds(starred: unknown): string | null {
  if (!Array.isArray(starred)) return null;
  const ids: string[] = [];
  for (const e of starred) {
    const id = (e as { _id?: unknown } | null)?._id;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids.length === 0 ? null : JSON.stringify(ids);
}

function read(starred: string | null): string[] {
  if (starred === null) return [];
  try {
    const v: unknown = JSON.parse(starred);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function starredBy(starred: string | null, uid: string): boolean {
  return read(starred).includes(uid);
}

/** The `starred` column after `uid` (un)starred the message. */
export function starredAfter(starred: string | null, uid: string, put: boolean): string | null {
  const others = read(starred).filter((x) => x !== uid);
  const ids = put ? [...others, uid] : others;
  return ids.length === 0 ? null : JSON.stringify(ids);
}
