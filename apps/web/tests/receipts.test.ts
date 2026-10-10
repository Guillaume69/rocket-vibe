import assert from "node:assert/strict";
import test from "node:test";
import { atLeast, seen, seenText } from "../src/receipts.ts";

const message = (id: string, author: string, position: string, extra = {}) =>
  ({
    id,
    room_id: "r",
    author: { id: author, username: author, display_name: "" },
    position,
    ...extra,
  }) as never;

test("positions compare as numbers", () => {
  assert.ok(atLeast("10", "9"));
  assert.ok(atLeast("9", "9"));
  assert.ok(!atLeast("9", "10"));
  assert.ok(atLeast("123456789012345678901", "123456789012345678900"));
});

test("my latest root message and who read up to it", () => {
  const messages = [
    message("a", "me", "5"),
    message("b", "bob", "6"),
    message("c", "me", "7"),
    message("t", "me", "8", { reply_to: "a" }),
  ];
  const reads = [
    { user_id: "bob", root_position: "7" },
    { user_id: "carol", root_position: "6" },
    { user_id: "me", root_position: "8" },
  ];
  assert.deepEqual(seen(messages, "me", reads), { id: "c", readers: ["bob"] });
  assert.equal(
    seen(messages, "me", [{ user_id: "carol", root_position: "6" }]),
    undefined,
  );
  assert.equal(seen(messages, "me", []), undefined);
  assert.equal(seen([message("b", "bob", "6")], "me", reads), undefined);
});

test("the line says Seen in a DM, names then others in a group", () => {
  const words = {
    seen: "Seen",
    seenBy: "Seen by",
    other: "and 1 other",
    others: (n: number) => `and ${n} others`,
  };
  const name = (id: string) => (id === "ghost" ? undefined : id.toUpperCase());
  assert.equal(seenText(["bob"], true, name, words), "Seen");
  assert.equal(
    seenText(["bob", "carol"], false, name, words),
    "Seen by BOB, CAROL",
  );
  assert.equal(
    seenText(["a", "b", "c", "d", "e"], false, name, words),
    "Seen by A, B, C and 2 others",
  );
  assert.equal(
    seenText(["a", "b", "c", "d"], false, name, words),
    "Seen by A, B, C and 1 other",
  );
  assert.equal(
    seenText(["bob", "ghost"], false, name, words),
    "Seen by BOB and 1 other",
  );
  assert.equal(seenText(["ghost"], false, name, words), "Seen");
});
