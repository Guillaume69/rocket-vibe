import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrangeTiles } from './voiceGrid.ts';

test('tiles fill the area, in the cells that hold the largest picture', () => {
  // Alone: the whole area.
  assert.deepEqual(arrangeTiles(1, 390, 700), { columns: 1, rows: 1, width: 390, height: 700 });
  // A phone held upright: two stacked, four two by two.
  assert.deepEqual(arrangeTiles(2, 390, 700), { columns: 1, rows: 2, width: 390, height: 345 });
  assert.equal(arrangeTiles(4, 390, 700).columns, 2);
  // Held sideways or a tablet: side by side.
  assert.equal(arrangeTiles(2, 1600, 900).columns, 2);
  assert.deepEqual(arrangeTiles(5, 1600, 900), { columns: 3, rows: 2, width: 526, height: 445 });
  assert.equal(arrangeTiles(0, 100, 100).columns, 1);
});
