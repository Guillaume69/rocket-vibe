import assert from "node:assert/strict";
import { test } from "node:test";

import { stepRoom } from "../src/room-step.ts";

test("shift arrows walk the listed rooms and stop at the ends", () => {
  const order = ["a", "b", "c"];
  assert.equal(stepRoom(order, "a", true), "b");
  assert.equal(stepRoom(order, "c", true), undefined);
  assert.equal(stepRoom(order, "a", false), undefined);
  assert.equal(stepRoom(order, undefined, true), "a");
  assert.equal(stepRoom(order, "gone", false), "c");
  assert.equal(stepRoom([], undefined, true), undefined);
});
