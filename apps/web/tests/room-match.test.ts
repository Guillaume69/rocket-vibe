import assert from "node:assert/strict";
import test from "node:test";
import { matchRooms } from "../src/room-match.ts";

type R = { name: string; at: number };
const rooms: R[] = [
  { name: "dev-ops", at: 1 },
  { name: "Équipe dev", at: 3 },
  { name: "devoirs", at: 2 },
  { name: "ad-hoc devs", at: 4 },
  { name: "android", at: 9 },
];
const names = (query: string) =>
  matchRooms(
    rooms,
    query,
    (room) => room.name,
    (room) => room.at,
  ).map((room) => room.name);

test("a name start, then a word start, then anywhere, latest first", () => {
  assert.deepEqual(names("DEV"), [
    "devoirs",
    "dev-ops",
    "ad-hoc devs",
    "Équipe dev",
  ]);
  assert.deepEqual(names("evo"), ["devoirs"]);
});

test("case and accents aside", () => {
  assert.deepEqual(names("equipe"), ["Équipe dev"]);
  assert.deepEqual(names("ÉQUIPE"), ["Équipe dev"]);
});

test("an empty query keeps every room, latest activity first", () => {
  assert.deepEqual(names(" "), [
    "android",
    "ad-hoc devs",
    "Équipe dev",
    "devoirs",
    "dev-ops",
  ]);
});
