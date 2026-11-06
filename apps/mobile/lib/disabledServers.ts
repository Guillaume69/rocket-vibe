/**
 * Disabled servers (user decision, 2026-11-06): a server stays on the rail,
 * greyed and after the others, keeps its session and stored messages, but is
 * not read in the background nor opened. Enabling it asks for no credentials.
 * Node-pure: `ui/disabledServerStore.ts` keeps the set in SecureStore.
 */

export function readDisabled(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string' && h !== '') : []);
  } catch {
    return new Set();
  }
}

export function writeDisabled(hosts: ReadonlySet<string>): string {
  return JSON.stringify([...hosts].sort());
}

/** The disabled servers after the enabled ones, each group in its order. */
export function disabledLast<T>(items: readonly T[], host: (item: T) => string, disabled: ReadonlySet<string>): T[] {
  return [...items.filter((i) => !disabled.has(host(i))), ...items.filter((i) => disabled.has(host(i)))];
}
