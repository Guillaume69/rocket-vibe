import { test } from "node:test";
import assert from "node:assert/strict";
import { listBreak } from "../src/composition.ts";
test("shift enter continues a numbered item, preserving following text", () => {
  assert.deepEqual(listBreak("  12. hello world", 11), {
    text: "  12. hello\n  13.  world",
    cursor: 18,
  });
});
test("an empty list item exits the list without posting its marker", () => {
  assert.deepEqual(listBreak("hello\n- ", 8), { text: "hello\n", cursor: 6 });
  assert.equal(listBreak("normal", 6), undefined);
});
