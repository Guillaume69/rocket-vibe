import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContextWindow, type HistoryReader } from './contextWindow.ts';

const NOW = 2_000_000_000_000;

type Item = { id: string; ts: number };

/** A room as 8.5 serves it: `range` answers the NEWEST page of `[oldest, latest]`. */
function room(timestamps: number[]) {
  const items = timestamps.map((ts, i) => ({ id: `m${String(i).padStart(4, '0')}`, ts }));
  const reader: HistoryReader<Item> & { requests: number } = {
    pageSize: 50,
    requests: 0,
    async range(latest, oldest) {
      reader.requests++;
      return items
        .filter((m) => (latest === null || m.ts <= latest) && (oldest === null || m.ts >= oldest))
        .reverse()
        .slice(0, 50);
    },
    async message(id) {
      reader.requests++;
      return items.find((m) => m.id === id) ?? null;
    },
  };
  return reader;
}

function indexes(window: ContextWindow<Item>): number[] {
  return window.messages.map((m) => Number(m.id.slice(1)));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

async function readForward(window: ContextWindow<Item>, localOldest: number | null) {
  for (let i = 0; i < 40 && window.hasNewer; i++) await window.newer(localOldest, NOW);
}

describe('ContextWindow', () => {
  test('reads forward without a hole up to the local history', async () => {
    const timestamps = range(0, 399).map((i) => 1_000_000 + i * 60_000);
    const reader = room(timestamps);
    const window = await ContextWindow.around(reader, 'm0100', timestamps[350], NOW);
    assert.ok(window !== null);
    assert.ok(window.hasOlder);
    assert.ok(window.hasNewer);
    const first = indexes(window);
    assert.ok(first[first.length - 1] > 100, 'the messages after the target come with it');
    assert.deepEqual(first, range(51, first[first.length - 1]));
    await readForward(window, timestamps[350]);
    assert.equal(window.hasNewer, false);
    assert.deepEqual(indexes(window), range(51, 350));
  });

  test('a burst after a quiet stretch is not skipped', async () => {
    const timestamps = range(0, 99).map((i) => 1_000_000 + i * 3_600_000);
    const burstStart = timestamps[99] + 3_600_000;
    timestamps.push(...range(0, 299).map((i) => burstStart + i * 20));
    timestamps.push(...range(0, 19).map((i) => burstStart + 3_600_000 + i * 3_600_000));
    const reader = room(timestamps);
    const window = await ContextWindow.around(reader, 'm0090', null, NOW);
    assert.ok(window !== null);
    await readForward(window, null);
    assert.equal(window.hasNewer, false);
    assert.deepEqual(indexes(window), range(41, timestamps.length - 1));
    assert.ok(reader.requests < 60, `${reader.requests} requests`);
  });

  test('more than a page within a second is read whole', async () => {
    const timestamps = range(0, 59).map((i) => 1_000_000 + i * 60_000);
    const instant = timestamps[59] + 60_000;
    timestamps.push(...range(0, 119).map((i) => instant + i * 5));
    timestamps.push(...range(1, 9).map((i) => instant + i * 60_000));
    const window = await ContextWindow.around(room(timestamps), 'm0055', null, NOW);
    assert.ok(window !== null);
    await readForward(window, null);
    assert.deepEqual(indexes(window), range(6, timestamps.length - 1));
  });

  test('reads back to the first message', async () => {
    const timestamps = range(0, 129).map((i) => 1_000_000 + i * 1_000);
    const window = await ContextWindow.around(room(timestamps), 'm0120', null, NOW);
    assert.ok(window !== null);
    while (window.hasOlder) await window.older();
    assert.equal(window.hasNewer, false, 'the room ends right after: the present is reached');
    assert.deepEqual(indexes(window), range(0, 129));
  });

  test('an unknown message has no window', async () => {
    assert.equal(await ContextWindow.around(room([1_000]), 'm0007', null, NOW), null);
  });
});
