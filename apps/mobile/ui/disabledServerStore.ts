/** The disabled servers (`lib/disabledServers.ts`), kept in SecureStore like the last rooms. */

import * as SecureStore from 'expo-secure-store';

import { readDisabled, writeDisabled } from '../lib/disabledServers.ts';
import { DISABLED_SERVERS_KEY } from '../lib/storageKeys.ts';

let hosts = (() => {
  try {
    return readDisabled(SecureStore.getItem(DISABLED_SERVERS_KEY));
  } catch {
    return new Set<string>();
  }
})();

export function disabledServers(): ReadonlySet<string> {
  return hosts;
}

export function setServerDisabled(host: string, disabled: boolean): ReadonlySet<string> {
  if (hosts.has(host) === disabled) return hosts;
  const next = new Set(hosts);
  if (disabled) next.add(host);
  else next.delete(host);
  hosts = next;
  void SecureStore.setItemAsync(DISABLED_SERVERS_KEY, writeDisabled(hosts)).catch(() => {});
  return hosts;
}
