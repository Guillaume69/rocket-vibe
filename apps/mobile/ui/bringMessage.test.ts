import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bringMessage } from './bringMessage.ts';

/** A simulated room: `local` = timestamps in the database, `server` = the whole history. */
function room(local: number[], server: number[], page = 3) {
  const base = new Set(local);
  const pages: number[] = [];
  return {
    pages,
    rankOf: (target: number) => async () =>
      base.has(target) ? [...base].filter((h) => h > target).length : null,
    older: async () => (base.size === 0 ? null : Math.min(...base)),
    loadPage: async (latest: number) => {
      pages.push(latest);
      const batch = server.filter((h) => h < latest).sort((a, b) => b - a).slice(0, page);
      for (const h of batch) base.add(h);
      return { oldest: batch.length === 0 ? null : Math.min(...batch) };
    },
  };
}

describe('bringMessage', () => {
  test('already in the database: its rank, without any request', async () => {
    const s = room([10, 20, 30], [10, 20, 30]);
    const rank = await bringMessage({ ts: 20, rank: s.rankOf(20), ...s });
    assert.equal(rank, 1);
    assert.deepEqual(s.pages, []);
  });

  test('missing: walks back page by page from the oldest local one, no gap', async () => {
    const server = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = room([9, 10], server);
    const rank = await bringMessage({ ts: 3, rank: s.rankOf(3), ...s });
    assert.deepEqual(s.pages, [9, 6]);
    assert.equal(rank, 7);
  });

  test('bounded: beyond `pagesMax`, gives up', async () => {
    const server = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = room([99, 100], server);
    const rank = await bringMessage({ ts: 1, rank: s.rankOf(1), ...s, pagesMax: 2 });
    assert.equal(rank, null);
    assert.equal(s.pages.length, 2);
  });

  test('target outside the main stream: stops as soon as it is passed', async () => {
    const s = room([2, 9, 10], [2, 9, 10]);
    const rank = await bringMessage({ ts: 5, rank: s.rankOf(5), ...s });
    assert.equal(rank, null);
    assert.deepEqual(s.pages, []);
  });

  test('history exhausted: a page that no longer moves back stops the walk', async () => {
    const s = room([9, 10], [9, 10]);
    const rank = await bringMessage({ ts: 3, rank: s.rankOf(3), ...s });
    assert.equal(rank, null);
    assert.deepEqual(s.pages, [9]);
  });
});
