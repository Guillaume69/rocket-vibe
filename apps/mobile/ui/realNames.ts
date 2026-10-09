/**
 * Whether the open Rocket.Chat server shows people by their real name
 * (`UI_Use_Real_Name`, a public setting, off by default), as its own clients
 * do: on, message authors and two-person DMs show `users.name` (falling back
 * to the username); off, usernames everywhere. Pushes already follow it: the
 * server writes `senderName` by the same setting.
 *
 * Module state like the custom emoji index, kept per server in SecureStore so
 * the first render (offline included) is already right; read again once per
 * session (`refreshRealNames`). Other providers leave it off: Mattermost names
 * people through its own display-name source.
 */

import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import type { RestClient } from '../lib/rest.ts';

let current = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (value === current) return;
  current = value;
  for (const listener of [...listeners]) listener();
}

/**
 * SecureStore keys take `[A-Za-z0-9._-]` only: every other character becomes
 * `_` and its code, so two servers never share a key (`http`/`https`, ports).
 */
function key(baseUrl: string): string {
  return `real-names-${baseUrl.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
}

/** At session start, before the first render: the last answer this server gave. */
export function restoreRealNames(baseUrl: string): void {
  try {
    set(SecureStore.getItem(key(baseUrl)) === '1');
  } catch {
    set(false);
  }
}

/** Reads the setting (`settings.public`, one call per session); a failure keeps the stored answer. */
export async function refreshRealNames(client: RestClient, isDiscarded: () => boolean): Promise<void> {
  const answer = await client.get<{ settings?: { _id?: unknown; value?: unknown }[] }>('settings.public', {
    params: { _id: 'UI_Use_Real_Name' },
  });
  const found = answer.settings?.find((s) => s._id === 'UI_Use_Real_Name');
  if (found === undefined || isDiscarded()) return;
  const value = found.value === true;
  set(value);
  await SecureStore.setItemAsync(key(client.baseUrl), value ? '1' : '0').catch(() => {});
}

/** End of session: the next server starts from its own answer. */
export function clearRealNames(): void {
  set(false);
}

export function realNames(): boolean {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useRealNames(): boolean {
  return useSyncExternalStore(subscribe, realNames, realNames);
}
