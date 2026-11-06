import assert from 'node:assert/strict';
import { test } from 'node:test';

import { disabledLast, readDisabled, writeDisabled } from './disabledServers.ts';

test('disabled servers round-trip and survive a damaged value', () => {
  const hosts = new Set(['b.example', 'a.example']);
  assert.deepEqual(readDisabled(writeDisabled(hosts)), hosts);
  assert.deepEqual(readDisabled(null), new Set());
  assert.deepEqual(readDisabled('not json'), new Set());
  assert.deepEqual(readDisabled('[1,"",{"x":1},"c.example"]'), new Set(['c.example']));
});

test('disabled servers go last, each group keeping its order', () => {
  const order = disabledLast(['a', 'b', 'c', 'd'], (h) => h, new Set(['a', 'c']));
  assert.deepEqual(order, ['b', 'd', 'a', 'c']);
});
