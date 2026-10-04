/**
 * Composer drafts (8.7), per `rid` or `rid:tmid`.
 *
 * In SQLite (table `drafts`), not MMKV, a recorded departure from the
 * plan: the draft is written DEBOUNCED (400 ms), so the database's async
 * latency is irrelevant, and one more native dependency (full rebuild, to be
 * justified against ROADMAP §4.2) does not beat "the database already covers
 * all local state". The database being per (server, account), drafts do not
 * leak from one account to another.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createDeferredDraft } from './deferredDraft.ts';
import type { DraftStore } from '../db/store.ts';

/**
 * `key: null` = not determinable yet (thread whose rid has not arrived):
 * `initial` stays `null` and nothing is written. The caller only mounts its
 * composer once `initial` is non-null, otherwise it would overwrite the draft
 * with ''.
 *
 * The store (not the raw `LocalDatabase`): its writes go through the
 * connection's queue; otherwise a debounce landing during a sync batch would
 * enter ITS transaction and vanish with it if the batch fails.
 */
export function useDraft(store: DraftStore, key: string | null) {
  const [state, setState] = useState<{ key: string | null; initial: string | null }>({
    key,
    initial: null,
  });
  // Key change DURING render (sanctioned React pattern, rather than a setState
  // in the effect): the old key's initial value must not leak into the new one.
  if (state.key !== key) setState({ key, initial: null });

  useEffect(() => {
    if (key === null) return;
    let canceled = false;
    store
      .read(key)
      .then((text) => {
        if (!canceled) setState({ key, initial: text ?? '' });
      })
      .catch(() => {
        if (!canceled) setState({ key, initial: '' });
      });
    return () => {
      canceled = true;
    };
  }, [store, key]);

  // The mechanics (debounce, flush, last-keystroke-wins) live in
  // `createDeferredDraft`, tested under Node. ONE instance PER KEY: its writes
  // are bound to `key` at creation, so a late flush can only write under the
  // key that saw the keystroke. Rejections are swallowed on purpose: a lost
  // draft is worth neither an error screen nor an unhandled rejection, the next
  // keystroke will write again.
  const deferred = useMemo(() => {
    if (key === null) return null;
    const swallow = (p: Promise<void>): void => {
      p.then(
        () => {},
        () => {},
      );
    };
    return createDeferredDraft({
      write: (text) => swallow(store.write(key, text)),
      delete: () => swallow(store.delete(key)),
    });
  }, [store, key]);

  // Leaving the screen OR changing key during the pause: without this flush,
  // the last typed characters would be lost. The cleanup holds the OLD key's
  // instance: that one writes, never the new one.
  useEffect(() => () => deferred?.flush(), [deferred]);

  /** Call on each keystroke: the write goes after a 400 ms pause. */
  const save = useCallback((text: string) => deferred?.save(text), [deferred]);

  /** On send: the draft is no longer needed, debounce included. */
  const clear = useCallback(() => deferred?.clear(), [deferred]);

  const initial = state.key === key ? state.initial : null;
  return useMemo(() => ({ initial, save, clear }), [initial, save, clear]);
}
