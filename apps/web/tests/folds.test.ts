import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptFolds,
  isFolded,
  setFolded,
  type FoldStorage,
} from "../src/folds.ts";

function memory(entries: Record<string, string> = {}): FoldStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (at) => [...map.keys()][at] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const labels = {
  unread: "Unread",
  favorites: "Favorites",
  channels: "Channels",
  direct: "Direct messages",
};

test("each account folds its own sections", () => {
  const storage = memory();
  setFolded(storage, "i:1:alice", "channels", true);
  assert.equal(isFolded(storage, "i:1:alice", "channels"), true);
  assert.equal(isFolded(storage, "i:1:bob", "channels"), false);
  setFolded(storage, "i:1:alice", "channels", false);
  assert.equal(isFolded(storage, "i:1:alice", "channels"), false);
  assert.equal(storage.map.size, 0);
});

test("the folds kept by title become the first account's, then go", () => {
  const storage = memory({
    "rv-fold:Channels": "true",
    "rv-fold:Direct messages": "false",
    "rv-fold:Salons": "true",
    "rv-language": "en",
  });
  adoptFolds(storage, "i:1:alice", labels);
  assert.equal(isFolded(storage, "i:1:alice", "channels"), true);
  assert.equal(isFolded(storage, "i:1:alice", "direct"), false);
  assert.deepEqual([...storage.map.keys()].sort(), [
    "rv-fold:i:1:alice:channels",
    "rv-language",
  ]);
});

test("another account signing in starts unfolded and drops the previous one's folds", () => {
  const storage = memory({ "rv-fold:i:1:alice:direct": "true" });
  adoptFolds(storage, "i:1:alice", labels);
  assert.equal(isFolded(storage, "i:1:alice", "direct"), true);
  adoptFolds(storage, "i:1:bob", labels);
  assert.equal(isFolded(storage, "i:1:bob", "direct"), false);
  assert.equal(storage.map.size, 0);
});
