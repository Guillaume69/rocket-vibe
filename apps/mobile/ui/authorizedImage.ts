/**
 * An image that only answers to a bearer header (Mattermost, kChat), shown
 * through a local copy. React Native's `<Image>` drops `source.headers` on
 * Android under the New Architecture (seen on the bench: the request reaches
 * the server without any token), so the bytes are fetched by
 * `expo-file-system`, which sends them, and the image gets a `file://` URI.
 * Rocket.Chat and RocketVibe URLs carry their own authentication and pass
 * through untouched.
 *
 * The cache key is the whole URL: a new photo version moves the URL, so a new
 * file. Bytes land in a `.part` file renamed once complete, so a download cut
 * short never passes for the image. A failure is remembered for thirty
 * seconds, so a missing photo is not fetched on every render, and is then
 * retried by the next row that shows it.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useReducer } from 'react';

import { mediaHeaders } from '../lib/mediaAuth.ts';

const ready = new Map<string, string>();
const failedAt = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

/** A failure (offline, a hiccup) is retried by the next row that shows the image after this long. */
const RETRY_AFTER_MS = 30_000;

function key(uri: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

function load(uri: string, headers: Record<string, string>): void {
  if (ready.has(uri) || pending.has(uri)) return;
  if (Date.now() - (failedAt.get(uri) ?? -Infinity) < RETRY_AFTER_MS) return;
  const folder = `${FileSystem.cacheDirectory ?? ''}authorized-media/`;
  const target = `${folder}${key(uri)}`;
  const partial = `${target}.part`;
  const run = (async () => {
    try {
      if ((await FileSystem.getInfoAsync(target)).exists) {
        ready.set(uri, target);
        return;
      }
      await FileSystem.makeDirectoryAsync(folder, { intermediates: true }).catch(() => {});
      const result = await FileSystem.downloadAsync(uri, partial, { headers });
      if (result.status >= 200 && result.status < 300) {
        await FileSystem.moveAsync({ from: partial, to: target });
        ready.set(uri, target);
        failedAt.delete(uri);
      } else {
        failedAt.set(uri, Date.now());
        await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => {});
      }
    } catch {
      failedAt.set(uri, Date.now());
      await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => {});
    } finally {
      pending.delete(uri);
      for (const listener of listeners.get(uri) ?? []) listener();
    }
  })();
  pending.set(uri, run);
}

/** The URI to give `<Image>`: the original, or the local copy once fetched, `null` meanwhile. */
export function useAuthorizedUri(uri: string | null | undefined): string | null | undefined {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const authorization = typeof uri === 'string' && uri !== '' ? mediaHeaders(uri)?.Authorization : undefined;
  useEffect(() => {
    if (authorization === undefined || typeof uri !== 'string') return;
    const own = listeners.get(uri) ?? new Set<() => void>();
    listeners.set(uri, own);
    own.add(refresh);
    load(uri, { Authorization: authorization });
    return () => {
      own.delete(refresh);
      if (own.size === 0) listeners.delete(uri);
    };
  }, [uri, authorization]);
  if (authorization === undefined || typeof uri !== 'string') return uri;
  return ready.get(uri) ?? null;
}
