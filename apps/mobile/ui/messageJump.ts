/**
 * Jump to a message: channel between the pinned/starred list and the room
 * screen still underneath. Same family as `ui/reply.ts`: the list arms the
 * target and closes; the room, already mounted, brings it into its window,
 * scrolls to it, then consumes it. Key = `rid`. Memory only.
 */

import { useSyncExternalStore } from 'react';

export type JumpTarget = {
  id: string;
  /** To know how far back to load history when the message is not stored. */
  ts: number;
};

const targets = new Map<string, JumpTarget>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export function requestJump(rid: string, target: JumpTarget): void {
  targets.set(rid, target);
  notify();
}

export function consumeJump(rid: string, id: string): void {
  if (targets.get(rid)?.id === id && targets.delete(rid)) notify();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => void subscribers.delete(subscriber);
}

export function useJump(rid: string): JumpTarget | null {
  return useSyncExternalStore(subscribe, () => targets.get(rid) ?? null);
}
