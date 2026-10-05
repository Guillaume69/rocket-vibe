/**
 * The current UI session's token: what lets a module-level cache refuse a
 * write that arrives too late.
 *
 * The exact problem: screen caches (`ui/loadedRooms.ts`,
 * `ui/loadedThreads.ts`, `ui/hotRooms.ts`) live at MODULE level, so they
 * outlive the tree's unmount. `ui/sync.tsx` purges them in its cleanup, but
 * that cleanup runs BEFORE those of the screens it carried. A room screen
 * unmounted right after therefore calls `keepWarm(...)` with releasers
 * pointing at a DDP client already `reset()`, and REPOPULATES the cache that
 * was just emptied.
 *
 * The ghost entry never clears again, and it LIES: the guard compares
 * generations for equality, yet the counter restarts from 0 in the next
 * session. As soon as the new session reaches the remembered value,
 * `roomCovered` answers "nothing to catch up" for a room this socket never
 * listened to; missed edits and deletions are then never fetched.
 *
 * A token fixes this with no delay or ordering: the screen captures the token
 * when it takes its subscriptions, and hands it back when handing them over.
 * If the token changed in between, the session those references belonged to
 * is dead: release instead of remembering. A causal fact, never a
 * chronological one, like `generation` itself.
 */

let token = 0;

/** Capture on MOUNT, hand back on unmount; never read in between. */
export function sessionToken(): number {
  return token;
}

/**
 * End of session / server switch. Called by the cache purges themselves:
 * whatever empties a session cache necessarily invalidates the token, and
 * forgetting either step would bring the defect back.
 */
export function invalidateSessionToken(): void {
  token += 1;
}
