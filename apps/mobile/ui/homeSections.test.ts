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
  unread: 'Non lus',
  favorites: 'Favoris',
  rooms: 'Salons',
  directMessages: 'Messages privés',
};

/** A minimal room: the array order IS recency order (sorted query). */
const room = (rid: string, type: string) => ({ rid, type });

const subscription = (
  rid: string,
  extra: Partial<{ unread: number; alert: boolean; open: boolean; favorite: boolean }> = {},
) => ({ rid, unread: 0, alert: false, open: true, favorite: false, ...extra });

/** Compact projection for assertions: `title: rid1, rid2`. */
const resume = (sections: { title: string; data: { room: { rid: string } }[] }[]): string[] =>
  sections.map((s) => `${s.title}: ${s.data.map((e) => e.room.rid).join(', ')}`);

describe('buildSections', () => {
  test('favourites get their section after unread, all types mixed', () => {
    // f1 (channel) and f2 (DM) are favourites; f3 too but has unreads: it stays
    // in "Non lus", like any room with a message.
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
    assert.deepEqual(resume(sections), ['Non lus: f3', 'Favoris: f1, f2', 'Salons: c1']);
  });

  test('split into Rooms / Direct messages, recency order kept, empty sections removed', () => {
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('p1', 'p'), room('d2', 'd')],
      [subscription('c1'), subscription('d1'), subscription('p1'), subscription('d2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Salons: c1, p1', 'Messages privés: d1, d2']);
  });

  test('unread and mentions move to the top, ALL TYPES MIXED', () => {
    // d1 has unreads, c2 an alert (a mention can raise the flag without the
    // counter moving): both go to "Non lus", the DM does NOT drop into
    // "Messages privés".
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('c2', 'c')],
      [subscription('c1'), subscription('d1', { unread: 3 }), subscription('c2', { alert: true })],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Non lus: d1, c2', 'Salons: c1']);
  });

  test('`open === false` hides the room; NO subscription → visible anyway', () => {
    // No subscription received yet (ingestion race): show rather than make the
    // list flicker. The entry then carries `subscription: null`.
    const sections = buildSections(
      [room('c1', 'c'), room('c2', 'c'), room('c3', 'c')],
      [subscription('c1', { open: false }), subscription('c2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2, c3']);
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
    assert.deepEqual(resume(sections), ['Salons: c2']);
  });

  test('all read → no "Non lus" section; no DM → no "Messages privés"', () => {
    const sections = buildSections([room('c1', 'c')], [subscription('c1')], TITLES);
    assert.deepEqual(resume(sections), ['Salons: c1']);
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
    assert.equal(readCollapsedSections('{pas du json').size, 0);
    assert.equal(readCollapsedSections('{"rooms":true}').size, 0);
    assert.deepEqual([...readCollapsedSections('["rooms","archives",3]')], ['rooms']);
    assert.equal(readCollapsedSections('["constructor","toString"]').size, 0);
  });

  test('keys stored before the English rename are still read', () => {
    const raw = '["nonLus","favoris","salons","messagesPrives"]';
    assert.deepEqual([...readCollapsedSections(raw)], ['unread', 'favorites', 'rooms', 'directMessages']);
  });
});
