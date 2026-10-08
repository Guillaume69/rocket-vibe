import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MmCategories, placements } from './categories.ts';
import { MmClient } from './client.ts';

const category = (id: string, type: string, channelIds: string[], name = id) => ({ id, type, display_name: name, channel_ids: channelIds });

describe('sidebar categories', () => {
  test('a room takes its category, its rank follows the server order', () => {
    const map = placements(
      [category('fav', 'favorites', ['f1']), category('tech', 'custom', ['t1'], 'TECH'), category('ch', 'channels', ['c1']), category('dm', 'direct_messages', ['d1'])],
      ['tech', 'fav', 'ch', 'dm'],
      0,
    );
    assert.deepEqual(map.get('t1'), { favorite: false, groupId: 'tech', groupName: 'TECH', rank: 0 });
    assert.deepEqual(map.get('f1'), { favorite: true, groupId: null, groupName: null, rank: 1 });
    assert.deepEqual(map.get('c1'), { favorite: false, groupId: null, groupName: null, rank: 2 });
    assert.equal(map.get('d1')?.rank, 3);
  });

  test('without an order, the categories keep the listed one', () => {
    assert.equal(placements([category('a', 'channels', ['x']), category('b', 'custom', ['y'])], null, 1000).get('y')?.rank, 1001);
  });

  test('every team is read, and the first one that lists a direct message places it', async () => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url.replace(/^http:\/\/x\/api\/v4/, ''));
      const body = url.endsWith('/users/me/teams')
        ? [{ id: 'A' }, { id: 'B' }]
        : url.includes('/teams/A/')
          ? { categories: [category('a-dm', 'direct_messages', ['dm']), category('a-ch', 'channels', ['ca'])], order: ['a-ch', 'a-dm'] }
          : { categories: [category('b-fav', 'favorites', ['dm', 'cb'])], order: ['b-fav'] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const categories = new MmCategories(new MmClient('http://x', 't', { fetch }));
    await categories.load();
    assert.deepEqual(calls, ['/users/me/teams', '/users/me/teams/A/channels/categories', '/users/me/teams/B/channels/categories']);
    assert.deepEqual(categories.placement('dm'), { favorite: false, groupId: null, groupName: null, rank: 1 });
    assert.deepEqual(categories.placement('cb'), { favorite: true, groupId: null, groupName: null, rank: 1000 });
  });

  test('a favourite accepted by the server moves the room before the categories are read again', async () => {
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith('/users/me/teams') ? [{ id: 'A' }] : { categories: [category('ch', 'channels', ['c1'])], order: ['ch'] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const categories = new MmCategories(new MmClient('http://x', 't', { fetch }));
    await categories.load();
    categories.noteFavorite('c1', true);
    assert.equal(categories.placement('c1')?.favorite, true);
    categories.noteFavorite('unknown', true);
    assert.equal(categories.placement('unknown'), undefined);
  });
});
