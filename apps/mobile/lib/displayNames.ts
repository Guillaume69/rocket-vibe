/**
 * The names people show under, by user id, when the server decides them
 * apart from usernames (Mattermost's name format). Module state, like the
 * emoji index: rows read it synchronously, and only the active account's is
 * set. Empty, every row shows the username.
 */
import type { DisplayNameSource } from '@rocket-vibe/provider-api/displayNames';
export type { DisplayNameSource } from '@rocket-vibe/provider-api/displayNames';

let names: ReadonlyMap<string, string> = new Map();
let statuses: ReadonlyMap<string, string> = new Map();
let mentions: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setDisplayNames(
  next: ReadonlyMap<string, string>,
  nextStatuses: ReadonlyMap<string, string> = new Map(),
  nextMentions: ReadonlyMap<string, string> = new Map(),
): void {
  names = next;
  statuses = nextStatuses;
  mentions = nextMentions;
  for (const listener of [...listeners]) listener();
}

export function displayNames(): ReadonlyMap<string, string> {
  return names;
}

/** `user id → custom status emoji` (a glyph), shown after the name. */
export function statusEmojis(): ReadonlyMap<string, string> {
  return statuses;
}

/** `username → name`, for `@username` mentions shown under the name format (Mattermost). */
export function mentionNames(): ReadonlyMap<string, string> {
  return mentions;
}

export function onDisplayNamesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function mountDisplayNames(source: DisplayNameSource | undefined): () => void {
  if (source === undefined) return () => {};
  const apply = () => setDisplayNames(source.names(), source.statuses(), source.mentions?.());
  apply();
  const unsubscribe = source.subscribe(apply);
  return () => {
    unsubscribe();
    setDisplayNames(new Map());
  };
}
