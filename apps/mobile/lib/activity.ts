/**
 * Tracking of background network activity, for the "updating..." indicator.
 *
 * Connection setup (global catch-up on launch, a room's history when it is
 * opened) runs fire-and-forget (see `ui/sync.tsx`): the cache shows at once,
 * but NOTHING says a fetch is refreshing it. This volatile store counts the
 * fetches IN FLIGHT per scope (`'global'`, or a `rid`); the UI reads it via
 * `useSyncExternalStore` (`ui/activity.ts`), like presence.
 *
 * A COUNTER, not a boolean: two concurrent fetches on the same scope (a room's
 * catch-up while its history loads) must not switch each other off; the scope
 * stays on as long as one remains.
 */
export class ActivityEngine {
  private readonly counters = new Map<string, number>();
  private readonly subscribers = new Set<() => void>();

  /**
   * Wraps a fetch: switches the scope on for the duration of the work, off at
   * the end, on success AND failure (`finally`), so a counter is never left
   * stuck. Rejects like the original promise: the caller (the reconnect
   * driver) keeps its error handling intact.
   */
  async track<T>(key: string, work: Promise<T>): Promise<T> {
    this.adjust(key, 1);
    try {
      return await work;
    } finally {
      this.adjust(key, -1);
    }
  }

  /** `true` while at least one fetch is in flight for this scope. */
  active(key: string): boolean {
    return (this.counters.get(key) ?? 0) > 0;
  }

  onChange(reread: () => void): () => void {
    this.subscribers.add(reread);
    return () => {
      this.subscribers.delete(reread);
    };
  }

  private adjust(key: string, delta: number): void {
    const before = this.counters.get(key) ?? 0;
    const after = before + delta;
    if (after <= 0) this.counters.delete(key);
    else this.counters.set(key, after);
    // Notify only if the scope's BOOLEAN state flipped: a second concurrent
    // fetch (1→2, 2→1) re-renders nobody; only switching on (0→1) and off
    // (1→0) count.
    if (before > 0 !== after > 0) {
      for (const reread of this.subscribers) reread();
    }
  }
}
