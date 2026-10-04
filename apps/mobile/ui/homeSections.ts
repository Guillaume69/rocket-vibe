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
 *     rest splits into Rooms / Direct messages;
 *   - an empty section is dropped;
 *   - the input order (recency descending, sorted by the query) is PRESERVED
 *     by each section: no re-sort here.
 */

export type HomeEntry<S, A> = { room: S; subscription: A | null };

export type SectionKey = 'unread' | 'favorites' | 'rooms' | 'directMessages';

export type SectionTitles = Record<SectionKey, string>;

export type HomeSection<E> = { key: SectionKey; title: string; data: E[] };

export function buildSections<
  S extends { rid: string; type: string },
  A extends { rid: string; unread: number; alert: boolean; open: boolean; favorite: boolean },
>(
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
  const unread = visible.filter(hasMessage);
  const favorites = visible.filter((e) => !hasMessage(e) && e.subscription?.favorite === true);
  const read = visible.filter((e) => !hasMessage(e) && e.subscription?.favorite !== true);

  const sections: HomeSection<HomeEntry<S, A>>[] = [
    { key: 'unread', title: titles.unread, data: unread },
    { key: 'favorites', title: titles.favorites, data: favorites },
    { key: 'rooms', title: titles.rooms, data: read.filter((e) => e.room.type !== 'd') },
    {
      key: 'directMessages',
      title: titles.directMessages,
      data: read.filter((e) => e.room.type === 'd'),
    },
  ];
  return sections.filter((s) => s.data.length > 0);
}

const SECTION_KEYS: readonly SectionKey[] = ['unread', 'favorites', 'rooms', 'directMessages'];

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
  const keys = value.map((k: unknown) => LEGACY_SECTION_KEYS.get(k) ?? k);
  return new Set(SECTION_KEYS.filter((key) => keys.includes(key)));
}

export function writeCollapsedSections(collapsedKeys: ReadonlySet<SectionKey>): string {
  return JSON.stringify(SECTION_KEYS.filter((key) => collapsedKeys.has(key)));
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
