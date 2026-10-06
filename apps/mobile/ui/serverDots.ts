/**
 * Servers a push said have something new, for the server rail's dots: a push
 * arrives before the next minute's read (`ui/serverRail.tsx`). In memory only:
 * the read that follows confirms or clears it.
 */
import { serverHost } from '../lib/accountUnread.ts';

const listeners = new Set<(host: string) => void>();

export function markServerUnread(server: string): void {
  const host = serverHost(server);
  for (const listener of listeners) listener(host);
}

export function onServerUnread(listener: (host: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
