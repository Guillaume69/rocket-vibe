/**
 * The current account's emoji usage (`db/store.ts#createEmojiUsageStore`), as
 * a module-level slot rather than a `SyncState` field: the reaction chips of
 * `ui/messageRow.tsx` count a use too, and a memoised row must not subscribe
 * to the sync context for it. `SyncProvider` mounts the store when the
 * account's database is ready and unmounts it at session end (the purge rule
 * of module stores: one account's counts never land in the next one's file).
 *
 * Leaf module: imports nothing from `sync`.
 */

import type { EmojiUsageStore } from '../db/store.ts';
import type { EmojiUse } from '../lib/emojiUsage.ts';

let current: EmojiUsageStore | null = null;

/** Gives the session's store; the returned function takes it back. */
export function mountEmojiUsage(store: EmojiUsageStore): () => void {
  current = store;
  return () => {
    if (current === store) current = null;
  };
}

/** One more use of `code`, fire-and-forget: a failed count is not worth an error. */
export function recordReaction(code: string): void {
  current?.record(code).catch(() => {});
}

/** Every counted use of the current account; nothing without a session. */
export function readEmojiUsage(): Promise<EmojiUse[]> {
  return current === null ? Promise.resolve([]) : current.read().catch(() => []);
}
