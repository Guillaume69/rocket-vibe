/**
 * "Keep my status online", per server (Teams): on unless turned off, kept in
 * SecureStore and applied to the provider as it starts. Mirrors the desktop's
 * `rv_core::keep_online`.
 */

import * as SecureStore from 'expo-secure-store';

import type { Provider } from '@rocket-vibe/provider-api/provider';

function key(baseUrl: string): string {
  return `keep-online-${baseUrl.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export async function keptOnline(baseUrl: string): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(key(baseUrl))) !== 'off';
  } catch {
    return true;
  }
}

export async function setKeptOnline(baseUrl: string, on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.deleteItemAsync(key(baseUrl));
    else await SecureStore.setItemAsync(key(baseUrl), 'off');
  } catch {
    // The choice still applies to the running connection.
  }
}

/** The stored choice, onto a provider that offers it. */
export async function applyKeptOnline(provider: Provider, baseUrl: string): Promise<void> {
  if (!provider.keepOnline) return;
  const on = await keptOnline(baseUrl);
  provider.keepOnline.set(on);
}
