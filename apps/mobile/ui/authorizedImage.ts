/** Android drops Image headers under the New Architecture: show a session-owned local copy. */
import { useEffect, useReducer } from 'react';
import { mediaLease, requiresMediaBearer, subscribeMediaAuth } from '../lib/mediaAuth.ts';
import { authorizedMedia } from './authorizedMedia.ts';

export function useAuthorizedUri(uri: string | null | undefined): string | null | undefined {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const lease = typeof uri === 'string' ? mediaLease(uri) : undefined;
  useEffect(() => subscribeMediaAuth(refresh), []);
  useEffect(() => {
    if (lease === undefined || typeof uri !== 'string') return;
    let alive = true;
    void authorizedMedia.get(lease, uri).then(() => { if (alive) refresh(); }).catch(() => {});
    return () => { alive = false; };
  }, [uri, lease]);
  if (typeof uri !== 'string') return uri;
  if (lease === undefined) return requiresMediaBearer(uri) ? null : uri;
  return authorizedMedia.peek(lease, uri);
}
