/**
 * Grouping of the room list (home screen): the PURE projection, pulled out of
 * the component to be testable under Node (`app/` has no tests).
 *
 * The rules, all visible on screen and none locked down until now:
 *   - rooms/subscriptions merged BY RID, in JS: `useCoalescedLiveQuery` only
 *     listens to the FROM table, an SQL join would miss writes that only touch
 *     `subscriptions`;
 *   - `open === false` hides the room; NO subscription received means visible,
 *     rather than making the list flicker;
 *   - "I have a message" = unreads > 0 OR the `alert` flag (a mention can raise
 *     it without the counter moving): those rooms rise to the top, ALL TYPES
 *     ALIKE; then come the rooms I starred (the server's star, `f`), then the
 *     rooms of each category of my own (Mattermost), then the rest splits
 *     into Rooms / Direct messages;
 *   - the sections after Unread follow my sidebar order (`groupRank`) when the
 *     server has one, the order above otherwise;
 *   - an empty section is dropped;
 *   - the input order (recency descending, sorted by the query) is PRESERVED
 *     by each section: no re-sort here.
 */

export type HomeEntry<S, A> = { room: S; subscription: A | null };

export type SectionKey = 'unread' | 'favorites' | 'rooms' | 'directMessages' | `group:${string}`;

export type SectionTitles = Record<'unread' | 'favorites' | 'rooms' | 'directMessages', string>;

export type HomeSection<E> = { key: SectionKey; title: string; data: E[] };

type Grouped = { rid: string; unread: number; alert: boolean; open: boolean; favorite: boolean; groupId?: string | null; groupName?: string | null; groupRank?: number | null };

const DEFAULT_RANKS = { favorites: 0, rooms: 1, directMessages: 2 } as const;

export function buildSections<S extends { rid: string; type: string }, A extends Grouped>(
  roomRows: S[] | undefined,
  subscriptionRows: A[] | undefined,
  titles: SectionTitles,
): HomeSection<HomeEntry<S, A>>[] {
  const subscriptionByRid = new Map((subscriptionRows ?? []).map((a) => [a.rid, a]));
  const visible: HomeEntry<S, A>[] = (roomRows ?? [])
    .filter((s) => subscriptionByRid.get(s.rid)?.open !== false)
    .map((s) => ({ room: s, subscription: subscriptionByRid.get(s.rid) ?? null }));

  const hasMessage = (e: HomeEntry<S, A>): boolean =>
    (e.subscription?.unread ?? 0) > 0 || e.subscription?.alert === true;
  const unread: HomeSection<HomeEntry<S, A>> = { key: 'unread', title: titles.unread, data: visible.filter(hasMessage) };

  const placed = new Map<SectionKey, HomeSection<HomeEntry<S, A>> & { rank: number; order: number }>();
  for (const entry of visible) {
    if (hasMessage(entry)) continue;
    const sub = entry.subscription;
    const groupName = sub?.groupName ?? null;
    const builtIn = sub?.favorite === true ? 'favorites' : entry.room.type === 'd' ? 'directMessages' : 'rooms';
    const key: SectionKey = sub?.favorite !== true && groupName !== null && sub?.groupId ? `group:${sub.groupId}` : builtIn;
    const rank = sub?.groupRank ?? DEFAULT_RANKS[builtIn];
    const section = placed.get(key);
    if (section === undefined) {
      const title = key.startsWith('group:') ? (groupName ?? '') : titles[builtIn];
      placed.set(key, { key, title, data: [entry], rank, order: key.startsWith('group:') ? 3 : DEFAULT_RANKS[builtIn] });
    } else {
      section.data.push(entry);
      section.rank = Math.min(section.rank, rank);
    }
  }
  const rest = [...placed.values()]
    .sort((x, y) => x.rank - y.rank || x.order - y.order)
    .map(({ key, title, data }) => ({ key, title, data }));
  return [unread, ...rest].filter((s) => s.data.length > 0);
}

const SECTION_KEYS: readonly SectionKey[] = ['unread', 'favorites', 'rooms', 'directMessages'];

const isSectionKey = (k: unknown): k is SectionKey =>
  typeof k === 'string' && ((SECTION_KEYS as readonly string[]).includes(k) || (k.startsWith('group:') && k.length > 6));

/** The keys as stored before the English rename (migration 0016). */
const LEGACY_SECTION_KEYS: ReadonlyMap<unknown, SectionKey> = new Map([
  ['nonLus', 'unread'],
  ['favoris', 'favorites'],
  ['salons', 'rooms'],
  ['messagesPrives', 'directMessages'],
]);

/**
 * Reads back the persisted collapsed sections. Anything that is not an array
 * of known keys (absent, corrupt storage, key from a future version) is
 * ignored: at worst, a section expands again.
 */
export function readCollapsedSections(raw: string | null): ReadonlySet<SectionKey> {
  if (raw === null) return new Set();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map((k: unknown) => LEGACY_SECTION_KEYS.get(k) ?? k).filter(isSectionKey));
}

export function writeCollapsedSections(collapsedKeys: ReadonlySet<SectionKey>): string {
  const groups = [...collapsedKeys].filter((key) => isSectionKey(key) && key.startsWith('group:')).sort();
  return JSON.stringify([...SECTION_KEYS.filter((key) => collapsedKeys.has(key)), ...groups]);
}

export function toggleSection(
  collapsedKeys: ReadonlySet<SectionKey>,
  key: SectionKey,
): ReadonlySet<SectionKey> {
  const following = new Set(collapsedKeys);
  if (following.has(key)) following.delete(key);
  else following.add(key);
  return following;
}

export type DisplayedSection<E> = HomeSection<E> & { collapsed: boolean; total: number };

/**
 * Clears the collapsed sections while keeping their count. A LONE section has
 * no header on screen, so no way to expand it: it stays expanded whatever the
 * persisted state.
 */
export function collapseSections<E>(
  sections: HomeSection<E>[],
  collapsedKeys: ReadonlySet<SectionKey>,
): DisplayedSection<E>[] {
  const collapsible = sections.length > 1;
  return sections.map((s) => {
    const collapsed = collapsible && collapsedKeys.has(s.key);
    return { ...s, data: collapsed ? [] : s.data, collapsed, total: s.data.length };
  });
}
