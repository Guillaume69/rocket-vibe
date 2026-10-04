/**
 * Attachment transfers in progress (save, share), and their progress. A
 * module-level store: the action starts from a sheet that closes right away,
 * but its progress shows on the message row, which listens by the same key
 * (the file's server path).
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Fraction 0..1, or `null` while the total size is unknown. */
export type Progress = number | null;

let inProgress = new Map<string, Progress>();
const subscribers = new Set<() => void>();

function publish(key: string, value: Progress | undefined): void {
  const next = new Map(inProgress);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  inProgress = next;
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** `undefined`: no transfer in progress for this file. */
export function useProgress(key: string | null): Progress | undefined {
  const read = useCallback(() => (key === null ? undefined : inProgress.get(key)), [key]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * Starts a transfer under this key. A second start during the first is
 * ignored: two downloads to the same destination would overwrite each other.
 * Returns `false` in that case.
 */
export async function transfer(
  key: string,
  work: (onProgress: (p: Progress) => void) => Promise<void>,
): Promise<boolean> {
  if (inProgress.has(key)) return false;
  publish(key, null);
  try {
    await work((p) => publish(key, p));
  } finally {
    publish(key, undefined);
  }
  return true;
}

/** "37 %", or "…" while the size is unknown. */
export function progressLabel(p: Progress): string {
  return p === null ? '…' : `${Math.round(p * 100)} %`;
}
