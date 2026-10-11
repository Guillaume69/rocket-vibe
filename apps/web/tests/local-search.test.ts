import { test } from "node:test";
import assert from "node:assert/strict";
import { searchLocal } from "../src/local-search.ts";
import type { Message, Room } from "../src/protocol.ts";

const user = { id: "u", username: "alice", display_name: "Alice" };
const room = (id: string, extra: Partial<Room> = {}): Room => ({
  id,
  name: id,
  kind: "public",
  revision: "1",
  ...extra,
});
const message = (
  id: string,
  room_id: string,
  text: string,
  minute: number,
  extra: Partial<Message> = {},
): Message => ({
  id,
  room_id,
  text,
  position: String(minute),
  revision: "1",
  author: user,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  ...extra,
});
const rooms = new Map([
  ["general", room("general")],
  ["random", room("random")],
  ["secret", room("secret", { encrypted: true })],
]);

test("finds across rooms, newest first, case ignored", () => {
  const hits = searchLocal(
    [
      message("1", "general", "Rocket launch at noon", 1),
      message("2", "random", "the ROCKET is ready", 3),
      message("3", "general", "nothing here", 2),
    ],
    rooms,
    "rocket",
  );
  assert.deepEqual(
    hits.map((hit) => [hit.message.id, hit.room.id]),
    [
      ["2", "random"],
      ["1", "general"],
    ],
  );
});

test("leaves out encrypted rooms, rooms left, deleted and system messages", () => {
  const hits = searchLocal(
    [
      message("1", "secret", "rocket", 1),
      message("2", "gone", "rocket", 2),
      message("3", "general", "rocket", 3, { deleted: true }),
      message("4", "general", "rocket", 4, {
        system: { kind: "joined" } as Message["system"],
      }),
      message("5", "general", "rocket", 5),
    ],
    rooms,
    "rocket",
  );
  assert.deepEqual(
    hits.map((hit) => hit.message.id),
    ["5"],
  );
});

test("an empty query finds nothing, accents count, the limit holds", () => {
  const many = Array.from({ length: 80 }, (_, index) =>
    message(String(index), "general", "café " + index, index),
  );
  assert.deepEqual(searchLocal(many, rooms, "   "), []);
  assert.equal(searchLocal(many, rooms, "cafe").length, 0);
  const hits = searchLocal(many, rooms, "CAFÉ");
  assert.equal(hits.length, 60);
  assert.equal(hits[0].message.id, "79");
});

test("replies are found too", () => {
  const hits = searchLocal(
    [message("r", "general", "deep in a thread", 1, { reply_to: "root" })],
    rooms,
    "thread",
  );
  assert.equal(hits[0].message.reply_to, "root");
});
