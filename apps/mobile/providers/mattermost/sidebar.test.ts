import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MmClient } from './client.ts';
import { DEFAULT_DM_LIMIT, MmSidebar } from './sidebar.ts';

const dm = (id: string, other: string, at: number) => ({ id, type: 'D', name: `u-me__${other}`, last_post_at: at });
const group = (id: string, at: number) => ({ id, type: 'G', name: id, last_post_at: at });

describe('MmSidebar', () => {
  const sidebar = () => new MmSidebar(new MmClient('http://x', 't'), 'u-me');

  test('a closed conversation is hidden unless something is unread', () => {
    const s = sidebar();
    s.apply([{ category: 'direct_channel_show', name: 'u-bob', value: 'false' }, { category: 'group_channel_show', name: 'g1', value: 'false' }], true);
    const channels = [dm('d1', 'u-bob', 5), group('g1', 4), dm('d2', 'u-carol', 3)];
    s.rank(channels);
    assert.deepEqual(channels.map((c) => s.isListed(c, 0)), [false, false, true]);
    assert.equal(s.isListed(channels[0]!, 2), true);
    assert.equal(s.isListed({ id: 'c1', type: 'O' }, 0), true);
  });

  test('only the most recent conversations of the Direct Messages category count against the limit', () => {
    const s = sidebar();
    assert.equal(s.limit, DEFAULT_DM_LIMIT);
    s.apply([{ category: 'sidebar_settings', name: 'limit_visible_dms_gms', value: '2' }], true);
    const channels = [dm('fav', 'u-a', 9), dm('d1', 'u-b', 8), dm('d2', 'u-c', 7), dm('d3', 'u-d', 6)];
    s.rank(channels, (rid) => rid === 'fav');
    assert.deepEqual(channels.map((c) => s.isListed(c, 0, c.id === 'fav')), [true, true, true, false]);
  });

  test('a conversation opened in this session stays listed after a new ranking', () => {
    const s = sidebar();
    s.apply([{ category: 'sidebar_settings', name: 'limit_visible_dms_gms', value: '1' }], true);
    const channels = [dm('d1', 'u-b', 8), dm('old', 'u-c', 1)];
    s.rank(channels);
    s.reveal('old');
    s.rank(channels);
    assert.equal(s.isListed(channels[1]!, 0), true);
  });

  test('a live change says whether the list moves', () => {
    const s = sidebar();
    s.apply([], true);
    assert.equal(s.apply([{ category: 'direct_channel_show', name: 'u-bob', value: 'true' }]), false);
    assert.equal(s.apply([{ category: 'direct_channel_show', name: 'u-bob', value: 'false' }]), true);
    assert.equal(s.apply([{ category: 'flagged_post', name: 'p1', value: 'true' }]), false);
  });
});
