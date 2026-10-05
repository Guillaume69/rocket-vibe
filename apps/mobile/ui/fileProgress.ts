/**
 * Keeps an upload's progress bar alive.
 *
 * The 0..1 fraction lives only in the engine's memory: no SQLite write carries
 * it, so `useCoalescedLiveQuery`, which listens to database changes, would
 * never see it move. That was the finding "the `progress` Map, announced for
 * the UI, is read nowhere": it was right, and invisible.
 *
 * So we subscribe to the engine itself. The rate is already bounded at the
 * source: `UploadEngine` only notifies on a WHOLE PERCENT change, not on every
 * chunk; otherwise re-rendering the room screen would cost more than the upload.
 */

import { useEffect, useReducer } from 'react';

import type { FileOutbox } from '../lib/provider.ts';

export function useFileProgress(files: FileOutbox): Map<string, number> {
  // The `Map` is mutated IN PLACE by the engine: its reference never changes,
  // so nothing would trigger a render. This counter is the signal.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => files.subscribe(redraw), [files]);
  return files.progress;
}
