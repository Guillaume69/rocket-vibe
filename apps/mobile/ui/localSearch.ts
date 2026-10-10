/**
 * Search across rooms, on the device, for the current account (the session's
 * database, mounted by `ui/sync.tsx` like the emoji usage store). Rocket.Chat
 * has no search spanning rooms (`chat.search` needs one), and asking each room
 * would spend the 10 requests a minute: SQLite, the source of truth, answers
 * instead, over what this device holds.
 */

import type { LocalSearch } from '../db/store.ts';

let current: LocalSearch | null = null;

export function mountLocalSearch(search: LocalSearch): () => void {
  current = search;
  return () => {
    if (current === search) current = null;
  };
}

/** Ids of the matching messages, newest first; none without a session. */
export function searchLocally(term: string, limit = 60): Promise<string[]> {
  return current === null || term.trim() === '' ? Promise.resolve([]) : current.search(term, limit);
}
