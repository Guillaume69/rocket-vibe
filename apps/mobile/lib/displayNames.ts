/**
 * The names people show under, by user id, when the server decides them
 * apart from usernames (Mattermost's name format). Module state, like the
 * emoji index: rows read it synchronously, and only the active account's is
 * set. Empty, every row shows the username.
 */

let names: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setDisplayNames(next: ReadonlyMap<string, string>): void {
  names = next;
  for (const listener of [...listeners]) listener();
}

export function displayNames(): ReadonlyMap<string, string> {
  return names;
}

export function onDisplayNamesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The provider's own map, kept current for as long as the session lives. */
export function mountDisplayNames(source: { names(): ReadonlyMap<string, string>; subscribe(listener: () => void): () => void } | undefined): () => void {
  if (source === undefined) return () => {};
  setDisplayNames(source.names());
  const unsubscribe = source.subscribe(() => setDisplayNames(source.names()));
  return () => {
    unsubscribe();
    setDisplayNames(new Map());
  };
}
