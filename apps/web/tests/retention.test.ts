import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES_KEPT_PER_ROOM, Model } from "../src/store.ts";
import type { Message } from "../src/protocol.ts";

const user = { id: "u", username: "alice", display_name: "Alice" };
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
const message = (
  id: string,
  minute: number,
  room_id = "room",
  extra: Partial<Message> = {},
): Message => ({
  id,
  position: String(minute),
  room_id,
  revision: "1",
  author: user,
  text: id,
  created_at: at(minute),
  ...extra,
});
const fill = (model: Model, room: string, count: number) => {
  for (let minute = 1; minute <= count; minute++)
    model.put(message(room + "-" + minute, minute, room));
};

test("the native quota is 500 messages per room", () => {
  assert.equal(MESSAGES_KEPT_PER_ROOM, 500);
});

test("each room keeps its newest messages, the snapshot with it", () => {
  const model = new Model();
  fill(model, "a", 8);
  fill(model, "b", 2);
  assert.equal(model.retain(3), 5);
  assert.deepEqual(
    model.timeline("a").map((item) => item.id),
    ["a-6", "a-7", "a-8"],
  );
  assert.equal(model.timeline("b").length, 2);
  assert.equal(model.snapshot().messages.length, 5);
});

test("a room within its quota is untouched", () => {
  const model = new Model();
  fill(model, "a", 3);
  assert.equal(model.retain(3), 0);
  assert.equal(model.messages.size, 3);
});

test("a thread root answered by a kept reply stays", () => {
  const model = new Model();
  model.put(message("root", 1));
  model.put(message("old", 2));
  model.put(message("other", 3));
  model.put(message("reply", 4, "room", { reply_to: "root" }));
  model.put(message("new", 5));
  assert.equal(model.retain(2), 2);
  assert.ok(model.messages.has("root"));
  assert.ok(model.messages.has("reply"));
  assert.ok(model.messages.has("new"));
  assert.ok(!model.messages.has("old"));
  assert.ok(!model.messages.has("other"));
});

test("a root whose replies all went goes too", () => {
  const model = new Model();
  model.put(message("root", 1));
  model.put(message("reply", 2, "room", { reply_to: "root" }));
  model.put(message("new", 3));
  assert.equal(model.retain(1), 2);
  assert.deepEqual([...model.messages.keys()], ["new"]);
});

test("the room on screen keeps all the history it shows", () => {
  const model = new Model();
  fill(model, "open", 6);
  fill(model, "closed", 6);
  assert.equal(model.retain(2, ["open"]), 4);
  assert.equal(model.timeline("open").length, 6);
  assert.equal(model.timeline("closed").length, 2);
});

test("ties on time keep the higher position", () => {
  const model = new Model();
  model.put({ ...message("low", 1), created_at: at(9) });
  model.put({ ...message("high", 2), created_at: at(9) });
  model.retain(1);
  assert.deepEqual([...model.messages.keys()], ["high"]);
});
