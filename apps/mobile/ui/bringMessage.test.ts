import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bringMessage } from './bringMessage.ts';

/** Un salon simulé : `local` = horodatages en base, `serveur` = tout l'historique. */
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
      const lot = server.filter((h) => h < latest).sort((a, b) => b - a).slice(0, page);
      for (const h of lot) base.add(h);
      return { oldest: lot.length === 0 ? null : Math.min(...lot) };
    },
  };
}

describe('amenerMessage', () => {
  test('déjà en base : son rang, sans aucune requête', async () => {
    const s = room([10, 20, 30], [10, 20, 30]);
    const rank = await bringMessage({ ts: 20, rank: s.rankOf(20), ...s });
    assert.equal(rank, 1);
    assert.deepEqual(s.pages, []);
  });

  test('absent : remonte page par page depuis le plus vieux local, sans trou', async () => {
    const server = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = room([9, 10], server);
    const rank = await bringMessage({ ts: 3, rank: s.rankOf(3), ...s });
    assert.deepEqual(s.pages, [9, 6]);
    assert.equal(rank, 7);
  });

  test('borné : au-delà de `pagesMax`, abandon', async () => {
    const server = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = room([99, 100], server);
    const rank = await bringMessage({ ts: 1, rank: s.rankOf(1), ...s, pagesMax: 2 });
    assert.equal(rank, null);
    assert.equal(s.pages.length, 2);
  });

  test('cible hors du flux principal : on s’arrête dès qu’on l’a dépassée', async () => {
    const s = room([2, 9, 10], [2, 9, 10]);
    const rank = await bringMessage({ ts: 5, rank: s.rankOf(5), ...s });
    assert.equal(rank, null);
    assert.deepEqual(s.pages, []);
  });

  test('passé épuisé : une page qui ne recule plus arrête la remontée', async () => {
    const s = room([9, 10], [9, 10]);
    const rank = await bringMessage({ ts: 3, rank: s.rankOf(3), ...s });
    assert.equal(rank, null);
    assert.deepEqual(s.pages, [9]);
  });
});
