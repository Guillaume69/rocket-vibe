/**
 * The names people show under, by user id, when the server decides them
 * apart from usernames (Mattermost's name format). Module state, like the
 * emoji index: rows read it synchronously, and only the active account's is
 * set. Empty, every row shows the username.
 */

let names: ReadonlyMap<string, string> = new Map();
let statuses: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setDisplayNames(next: ReadonlyMap<string, string>, nextStatuses: ReadonlyMap<string, string> = new Map()): void {
  names = next;
  statuses = nextStatuses;
  for (const listener of [...listeners]) listener();
}

export function displayNames(): ReadonlyMap<string, string> {
  return names;
}

/** `user id → custom status emoji` (a glyph), shown after the name. */
export function statusEmojis(): ReadonlyMap<string, string> {
  return statuses;
}

export function onDisplayNamesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The provider's own map, kept current for as long as the session lives. */
export type DisplayNameSource = {
  names(): ReadonlyMap<string, string>;
  statuses(): ReadonlyMap<string, string>;
  subscribe(listener: () => void): () => void;
};

export function mountDisplayNames(source: DisplayNameSource | undefined): () => void {
  if (source === undefined) return () => {};
  setDisplayNames(source.names(), source.statuses());
  const unsubscribe = source.subscribe(() => setDisplayNames(source.names(), source.statuses()));
  return () => {
    unsubscribe();
    setDisplayNames(new Map());
  };
}
