/**
 * Search across rooms, on the device, for the current account (the session's
 * database, mounted by `ui/sync.tsx` like the emoji usage store). Rocket.Chat
 * has no search spanning rooms (`chat.search` needs one), and asking each room
 * would spend the 10 requests a minute: SQLite, the source of truth, answers
 * instead, over what this device holds. The Activity view reads its material
 * through the same holder, for the same reason.
 */

import type { ActivitySource, LocalSearch } from '../db/store.ts';

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

/** How many of the newest candidates the Activity view classifies. */
const ACTIVITY_SCAN = 2000;

/** The Activity view's material (`app/activity.tsx`); empty without a session. */
export function readActivity(userId: string): Promise<ActivitySource> {
  return current === null
    ? Promise.resolve({ messages: [], roots: [], repliedThreads: [], rooms: [] })
    : current.activity(userId, ACTIVITY_SCAN);
}
