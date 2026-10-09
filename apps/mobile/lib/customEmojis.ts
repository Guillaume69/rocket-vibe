/**
 * The server's custom emojis.
 *
 * `msg.md` delivers `:party_parrot:` like any other shortcode,
 * `{type:'EMOJI', shortCode:'party_parrot'}` without `unicode`, which is
 * indistinguishable from an unknown emoji. What tells it apart lives here: the
 * server's `emoji-custom.list`, which gives the FILE name (`party_parrot.png`)
 * to display. Rendering therefore decides in this order: Unicode character
 * (`lib/emojis.ts`), else custom image (here), else literal `:name:`.
 *
 * The URL is PUBLIC: `/emoji-custom/:name.:ext` answers without `rc_token`,
 * unlike files and avatars (`FileUpload_ProtectFiles` does not cover emojis,
 * checked on 8.5). It is built from the CANONICAL name:
 * `/emoji-custom/:alias.:ext` returns a fallback SVG, not the image.
 *
 * MODULE state, resolved synchronously like `unicodeOfShortcode`: markdown
 * rendering is not reactive, and an async read per emoji would be absurd.
 * Since the SQLite database is per (server, account), only one server is
 * indexed at a time: the active session's, set by `setCustomEmojis`.
 */

export type CustomEmoji = { name: string; extension: string; aliases: string[]; uri?:string };

/** Custom emoji persistence. Implemented on SQLite (`db/store.ts`). */
export interface EmojiStore {
  /** Replaces the WHOLE table with `entries` (the server list is complete). */
  replace(entries: CustomEmoji[]): Promise<void>;
  list(): Promise<CustomEmoji[]>;
}

type Target = { name: string; extension: string; uri?:string };

/** An `unknown` (network or database JSON) to a clean alias list. */
export function filterAliases(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Unfolds names and aliases into a `shortcode → file` index. **Two passes**:
 * all canonical names first, then the aliases, so a name can NEVER be hidden
 * by another entry's alias of the same name, whatever the server's order.
 * Between two valid entries, the first one set wins.
 */
export function buildIndex(entries: CustomEmoji[]): Map<string, Target> {
  const index = new Map<string, Target>();
  const valid = entries.filter(
    (e) => typeof e?.name === 'string' && typeof e.extension === 'string',
  );
  for (const e of valid) {
    if (!index.has(e.name)) index.set(e.name, { name: e.name, extension: e.extension, ...(e.uri?{uri:e.uri}:{}) });
  }
  for (const e of valid) {
    for (const alias of e.aliases ?? []) {
      if (typeof alias === 'string' && !index.has(alias)) {
        index.set(alias, { name: e.name, extension: e.extension, ...(e.uri?{uri:e.uri}:{}) });
      }
    }
  }
  return index;
}

let index = new Map<string, Target>();
let activeBase: string | null = null;
// Cache of `customEmojiCodes()`: rebuilt only when the index changes, not on
// every composer keystroke. Invalidated wherever `index` is reassigned.
let codesCache: readonly string[] | null = null;

// The index must be OBSERVABLE by the UI: the emoji picker never unmounts
// (`useEmojiPanel` mounts it once and for all), so "read on mount" means
// "frozen for the session". On first install, `syncCustomEmojis` runs AFTER
// mount and the ⭐ tab did not exist. `onCustomEmojisChange` + `customEmojiCodes`
// form the `useSyncExternalStore` contract: the frozen cache above IS the
// stable snapshot.
const subscribers = new Set<() => void>();

function notifyChange(): void {
  for (const subscriber of [...subscribers]) subscriber();
}

/** Subscribes to index reassignments; returns the unsubscribe. */
export function onCustomEmojisChange(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** Sets the active server's index. Called at startup, then after a fetch. */
export function setCustomEmojis(baseUrl: string, entries: CustomEmoji[]): void {
  activeBase = baseUrl.replace(/\/+$/, '');
  index = buildIndex(entries);
  codesCache = null;
  notifyChange();
}

/** On logout: a surviving index would serve the previous server's emojis. */
export function clearCustomEmojis(): void {
  index = new Map();
  activeBase = null;
  codesCache = null;
  notifyChange();
}

/**
 * Absolute image URL of a custom shortcode, or `null` if it is not one.
 * `Map.get` does not walk `Object`'s prototype, so no guard is needed.
 */
export function customEmojiUrl(shortCode: string): string | null {
  const target = index.get(shortCode);
  if (target === undefined || activeBase === null) return null;
  return target.uri??`${activeBase}/emoji-custom/${encodeURIComponent(target.name)}.${encodeURIComponent(target.extension)}`;
}

/**
 * All known custom shortcodes (canonical names AND aliases), for
 * autocompletion. FROZEN and cached: the same array is returned as long as the
 * index does not change (invalidated by `setCustomEmojis`/`clearCustomEmojis`),
 * so no copy and no mutation risk on each keystroke.
 */
export function customEmojiCodes(): readonly string[] {
  return (codesCache ??= Object.freeze([...index.keys()]));
}

/** An `unknown` from the network to a clean entry, or `null` if unusable. */
export function normalizeEntry(raw: unknown): CustomEmoji | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { name?: unknown; extension?: unknown; aliases?: unknown };
  if (typeof o.name !== 'string' || typeof o.extension !== 'string') return null;
  return { name: o.name, extension: o.extension, aliases: filterAliases(o.aliases) };
}

type ListResponse = { emojis?: { update?: unknown[] } };

/** The subset of `RestClient` needed here, to test without it. */
type ReadClient = {
  baseUrl: string;
  get: <T>(
    path: string,
    options?: { params?: Record<string, string | number | boolean | undefined> },
  ) => Promise<T>;
};

/**
 * Loads `emoji-custom.list` (in full), replaces the table and sets the index.
 * Full rather than incremental: the list is small, and a delta with its
 * `remove[]` would be complexity for no gain. Silent on failure: offline, the
 * already loaded SQLite table is authoritative and customs degrade to `:name:`.
 *
 * NO parameters: `emoji-custom.list` accepts ONLY `updatedSince`; a `count`
 * answers "must NOT have additional properties" (checked on 8.5). And the
 * table is replaced ONLY on a list actually received: a failed call, whose
 * `update` would be `undefined`, must not EMPTY the offline cache.
 *
 * `isDiscarded`: the index is MODULE state, shared by all sessions. A fetch
 * started for server A that resolves AFTER a logout or a server switch must
 * not re-arm the index (it would leak A's images into B's UI, plus an
 * unauthenticated request to A).
 */
export async function syncCustomEmojis(
  client: ReadClient,
  store: EmojiStore,
  isDiscarded: () => boolean = () => false,
  list?: () => Promise<CustomEmoji[]>,
): Promise<void> {
  let entries: CustomEmoji[];
  if (list !== undefined) entries = await list();
  else {
    const response = await client.get<ListResponse>('emoji-custom.list');
    const raw = response.emojis?.update;
    if (!Array.isArray(raw)) return;
    entries = raw.map(normalizeEntry).filter((e): e is CustomEmoji => e !== null);
  }
  await store.replace(entries);
  if (isDiscarded()) return;
  setCustomEmojis(client.baseUrl, entries);
}

/** At startup: the (offline) SQLite table to the in-memory index. */
export async function restoreCustomEmojis(
  baseUrl: string,
  store: EmojiStore,
  isDiscarded: () => boolean = () => false,
): Promise<void> {
  const entries = await store.list();
  if (isDiscarded()) return;
  setCustomEmojis(baseUrl, entries);
}
