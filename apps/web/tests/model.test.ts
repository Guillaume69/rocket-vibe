import { test } from "node:test";
import assert from "node:assert/strict";
import { Model, newer } from "../src/store.ts";
import type { Message, Room, MessageQuote } from "../src/protocol.ts";
const user = { id: "u", username: "alice", display_name: "Alice" };
const room = (id: string, member = "one"): Room => ({
  id,
  name: id,
  kind: "public",
  revision: "1",
  read_state: {
    room_id: id,
    membership_version: member,
    favorite_revision: "1",
    revision: "1",
    root_position: "0",
    reply_position: "0",
    unread_roots: "0",
    unread_replies: "0",
    mentions: "0",
    group_mentions: "0",
    favorite: false,
  },
});
const message = (
  id: string,
  position: string,
  room_id = "room",
  revision = "1",
): Message => ({
  id,
  position,
  room_id,
  revision,
  author: user,
  text: id,
  created_at: "2026-10-08T10:00:00Z",
});
test("orders durable positions beyond JavaScript safe integers without collision", () => {
  const model = new Model();
  model.rooms.set("room", room("room"));
  model.put(message("b", "9007199254740993"));
  model.put(message("a", "9007199254740992"));
  assert.deepEqual(
    model.timeline("room").map((item) => item.id),
    ["a", "b"],
  );
  assert.ok(newer("9007199254740994", "9007199254740993"));
});
test("an old history page never resurrects a deleted message", () => {
  const model = new Model();
  model.put({ ...message("a", "1", "room", "9"), deleted: true });
  model.put(message("a", "1", "room", "2"));
  assert.equal(model.messages.get("a")?.deleted, true);
  assert.deepEqual(model.timeline("room"), []);
});
test("room removal purges its history and quoted private text in other rooms", () => {
  const model = new Model();
  model.rooms.set("secret", room("secret"));
  model.rooms.set("room", room("room"));
  model.put(message("private", "1", "secret"));
  const quote: MessageQuote = {
    reference: { room_id: "secret", message_id: "private", revision: "1" },
    view_position: "1",
    excerpt: {
      author: user,
      text: "do not retain private text",
      created_at: "2026-10-08T10:00:00Z",
      revision: "1",
      membership_version: "one",
    },
  };
  model.put({ ...message("quote", "2"), quotes: [quote] });
  model.batch({
    protocol_version: 1,
    cursor: "next",
    has_more: false,
    changes: [{ type: "room_removed", data: { room_id: "secret" } }],
  });
  assert.equal(model.messages.has("private"), false);
  assert.equal(model.rooms.has("secret"), false);
  assert.equal(model.messages.get("quote")?.quotes?.[0].excerpt, null);
  assert.ok(!JSON.stringify(model.snapshot()).includes("do not retain"));
});
test("rejoin starts a new membership lifetime without prior cached room content", () => {
  const model = new Model();
  model.rooms.set("room", room("room"));
  model.put(message("old", "1"));
  model.batch({
    protocol_version: 1,
    cursor: "next",
    has_more: false,
    changes: [{ type: "room_upsert", data: room("room", "two") }],
  });
  assert.deepEqual(model.timeline("room"), []);
});
test("late upserts for a withdrawn room are ignored", () => {
  const model = new Model();
  model.batch({
    protocol_version: 1,
    cursor: "next",
    has_more: false,
    changes: [{ type: "message_upsert", data: message("unavailable", "1") }],
  });
  assert.equal(model.messages.size, 0);
});
test("room favorites update at the same public revision", () => {
  const model = new Model();
  model.rooms.set("room", room("room"));
  const update = room("room");
  update.read_state!.favorite = true;
  update.read_state!.favorite_revision = "8";
  model.batch({
    protocol_version: 1,
    cursor: "next",
    has_more: false,
    changes: [{ type: "room_upsert", data: update }],
  });
  assert.equal(model.rooms.get("room")?.read_state?.favorite, true);
});
