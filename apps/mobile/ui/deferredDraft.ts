/**
 * The deferred mechanics of drafts, extracted from `useDraft` to be testable
 * under Node, with an injected clock like `lib/reconnect.ts`.
 *
 * An instance is BOUND to a draft key: its `write`/`delete` target that key
 * and no other. That binding carries the hook's invariant "on key change, the
 * pending text goes under the OLD key, never the new one": the hook creates
 * one instance per key (`useMemo`) and FLUSHES the old one in its effect's
 * cleanup. Before the extraction, the invariant only held through the
 * dependency chain `[write]` → `[store, key]`, which no test or type locked;
 * now the mechanics are proven here, and the hook's remaining glue is
 * `exhaustive-deps`' business.
 */

export type DeferredDraft = {
  /** On each keystroke: the write goes after the pause, the last one wins. */
  save(text: string): void;
  /** On send: IMMEDIATE deletion, pending keystroke included. */
  clear(): void;
  /**
   * On unmount or key change: whatever is pending goes RIGHT AWAY. With nothing
   * pending (already written, or never typed), writes nothing: flushing twice
   * does not write twice.
   */
  flush(): void;
};

export const DRAFT_DELAY_MS = 400;

type Dependencies = {
  /** Writes the draft (non-blank text) under the key bound to the instance. */
  write: (text: string) => void;
  /** Deletes the draft: BLANK text means deletion, not a write. */
  delete: () => void;
  timeoutMs?: number;
  /** Injectable clock: `setTimeout`/`clearTimeout` by default. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export function createDeferredDraft(dep: Dependencies): DeferredDraft {
  const timeoutMs = dep.timeoutMs ?? DRAFT_DELAY_MS;
  const schedule = dep.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    dep.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  /** The text typed but not yet written: what the flush works on. */
  let paused: string | null = null;

  const set = (text: string): void => {
    if (text.trim() === '') dep.delete();
    else dep.write(text);
  };

  return {
    save(text) {
      paused = text;
      if (timer !== null) cancel(timer);
      timer = schedule(() => {
        // Reset BEFORE the write: a flush following the timer firing must not replay
        // text already sent. Redundant with `flush`'s `timer === null` guard on
        // purpose: each is sufficient alone, and the removal proof must remove them
        // TOGETHER.
        timer = null;
        paused = null;
        set(text);
      }, timeoutMs);
    },

    clear() {
      if (timer !== null) cancel(timer);
      timer = null;
      paused = null;
      set('');
    },

    flush() {
      if (timer === null) return;
      cancel(timer);
      timer = null;
      if (paused !== null) set(paused);
      paused = null;
    },
  };
}
