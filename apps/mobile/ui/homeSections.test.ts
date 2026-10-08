import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  toggleSection,
  type SectionKey,
  buildSections,
  writeCollapsedSections,
  readCollapsedSections,
  collapseSections,
} from './homeSections.ts';

const TITLES = {
  unread: 'Unread',
  favorites: 'Favorites',
  rooms: 'Rooms',
  directMessages: 'Direct messages',
};

/** A minimal room: the array order IS recency order (sorted query). */
const room = (rid: string, type: string) => ({ rid, type });

const subscription = (
  rid: string,
  extra: Partial<{ unread: number; alert: boolean; open: boolean; favorite: boolean; groupId: string; groupName: string; groupRank: number }> = {},
) => ({ rid, unread: 0, alert: false, open: true, favorite: false, ...extra });

/** Compact projection for assertions: `title: rid1, rid2`. */
const resume = (sections: { title: string; data: { room: { rid: string } }[] }[]): string[] =>
  sections.map((s) => `${s.title}: ${s.data.map((e) => e.room.rid).join(', ')}`);

describe('buildSections', () => {
  test('favourites get their section after unread, all types mixed', () => {
    // f1 (channel) and f2 (DM) are favourites; f3 too but has unreads: it stays
    // in "Unread", like any room with a message.
    const sections = buildSections(
      [room('f1', 'c'), room('c1', 'c'), room('f2', 'd'), room('f3', 'p')],
      [
        subscription('f1', { favorite: true }),
        subscription('c1'),
        subscription('f2', { favorite: true }),
        subscription('f3', { favorite: true, unread: 1 }),
      ],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Unread: f3', 'Favorites: f1, f2', 'Rooms: c1']);
  });

  test('split into Rooms / Direct messages, recency order kept, empty sections removed', () => {
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('p1', 'p'), room('d2', 'd')],
      [subscription('c1'), subscription('d1'), subscription('p1'), subscription('d2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Rooms: c1, p1', 'Direct messages: d1, d2']);
  });

  test('unread and mentions move to the top, ALL TYPES MIXED', () => {
    // d1 has unreads, c2 an alert (a mention can raise the flag without the
    // counter moving): both go to "Unread", the DM does NOT drop into
    // "Direct messages".
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('c2', 'c')],
      [subscription('c1'), subscription('d1', { unread: 3 }), subscription('c2', { alert: true })],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Unread: d1, c2', 'Rooms: c1']);
  });

  test('`open === false` hides the room; NO subscription → visible anyway', () => {
    // No subscription received yet (ingestion race): show rather than make the
    // list flicker. The entry then carries `subscription: null`.
    const sections = buildSections(
      [room('c1', 'c'), room('c2', 'c'), room('c3', 'c')],
      [subscription('c1', { open: false }), subscription('c2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Rooms: c2, c3']);
    const entries = sections[0].data;
    assert.notEqual(entries[0].subscription, null);
    assert.equal(entries[1].subscription, null);
  });

  test('a hidden but UNREAD room stays hidden: hiding wins', () => {
    const sections = buildSections(
      [room('c1', 'c'), room('c2', 'c')],
      [subscription('c1', { open: false, unread: 5 }), subscription('c2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Rooms: c2']);
  });

  test('all read → no "Unread" section; no DM → no "Direct messages"', () => {
    const sections = buildSections([room('c1', 'c')], [subscription('c1')], TITLES);
    assert.deepEqual(resume(sections), ['Rooms: c1']);
  });

  test('live queries not resolved yet (undefined): empty list, no crash', () => {
    assert.deepEqual(buildSections(undefined, undefined, TITLES), []);
  });
});

describe('collapsed sections', () => {
  const sections = () =>
    buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('c2', 'c')],
      [subscription('c1'), subscription('d1'), subscription('c2')],
      TITLES,
    );

  test('a collapsed section empties but keeps its count', () => {
    const shown = collapseSections(sections(), new Set(['rooms'] as const));
    assert.deepEqual(
      shown.map((s) => [s.key, s.collapsed, s.total, s.data.length]),
      [
        ['rooms', true, 2, 0],
        ['directMessages', false, 1, 1],
      ],
    );
  });

  test('a LONE section never collapses: without a header, nothing would reopen it', () => {
    const single = buildSections([room('c1', 'c')], [subscription('c1')], TITLES);
    const [shown] = collapseSections(single, new Set(['rooms'] as const));
    assert.equal(shown.collapsed, false);
    assert.equal(shown.data.length, 1);
  });

  test('toggling collapses then expands, without mutating the received set', () => {
    const empty = new Set<SectionKey>();
    const collapsed = toggleSection(empty, 'directMessages');
    assert.deepEqual([...collapsed], ['directMessages']);
    assert.equal(empty.size, 0);
    assert.deepEqual([...toggleSection(collapsed, 'directMessages')], []);
  });

  test('round trip through storage', () => {
    const collapsed = new Set<SectionKey>(['directMessages', 'unread']);
    const raw = writeCollapsedSections(collapsed);
    assert.equal(raw, '["unread","directMessages"]');
    assert.deepEqual(readCollapsedSections(raw), collapsed);
  });

  test('storage missing, corrupt or unknown: nothing collapsed', () => {
    assert.equal(readCollapsedSections(null).size, 0);
    assert.equal(readCollapsedSections('{not json').size, 0);
    assert.equal(readCollapsedSections('{"rooms":true}').size, 0);
    assert.deepEqual([...readCollapsedSections('["rooms","archives",3]')], ['rooms']);
    assert.equal(readCollapsedSections('["constructor","toString"]').size, 0);
  });

  test('keys stored before the English rename are still read', () => {
    const raw = '["nonLus","favoris","salons","messagesPrives"]';
    assert.deepEqual([...readCollapsedSections(raw)], ['unread', 'favorites', 'rooms', 'directMessages']);
  });
});

describe('sidebar categories (Mattermost)', () => {
  test('my own categories get a section each, and the sections follow my sidebar order', () => {
    const sections = buildSections(
      [room('t1', 'c'), room('fav', 'd'), room('c1', 'c'), room('u1', 'c'), room('i1', 'p'), room('d1', 'd')],
      [
        subscription('t1', { groupId: 'g-tech', groupName: 'TECH', groupRank: 0 }),
        subscription('i1', { groupId: 'g-infra', groupName: 'Infra', groupRank: 2 }),
        subscription('fav', { favorite: true, groupRank: 3 }),
        subscription('c1', { groupRank: 4 }),
        subscription('d1', { groupRank: 5 }),
        subscription('u1', { unread: 2, groupId: 'g-tech', groupName: 'TECH', groupRank: 0 }),
      ],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Unread: u1', 'TECH: t1', 'Infra: i1', 'Favorites: fav', 'Rooms: c1', 'Direct messages: d1']);
    assert.deepEqual(sections.map((s) => s.key).slice(1, 3), ['group:g-tech', 'group:g-infra']);
  });

  test('a favourite leaves its old category at once, before the server says so', () => {
    const sections = buildSections(
      [room('a', 'c'), room('b', 'c')],
      [subscription('a', { favorite: true, groupId: 'g', groupName: 'G', groupRank: 1 }), subscription('b', { groupId: 'g', groupName: 'G', groupRank: 1 })],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Favorites: a', 'G: b']);
  });

  test('a folded category is remembered by its id', () => {
    const collapsed = new Set<SectionKey>(['group:g-tech', 'rooms']);
    const raw = writeCollapsedSections(collapsed);
    assert.equal(raw, '["rooms","group:g-tech"]');
    assert.deepEqual(readCollapsedSections(raw), collapsed);
    assert.deepEqual([...readCollapsedSections('["group:","nope"]')], []);
  });
});
