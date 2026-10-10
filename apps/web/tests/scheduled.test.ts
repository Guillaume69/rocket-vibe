import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptable,
  forRoom,
  inOneHour,
  localInput,
  tomorrowMorning,
  when,
} from "../src/scheduled.ts";

test("the offered times", () => {
  const now = new Date(2026, 9, 11, 23, 30);
  assert.equal(inOneHour(now).getTime() - now.getTime(), 3_600_000);
  const morning = tomorrowMorning(now);
  assert.deepEqual(
    [morning.getDate(), morning.getHours(), morning.getMinutes()],
    [12, 8, 0],
  );
  assert.equal(localInput(new Date(2026, 0, 5, 7, 3)), "2026-01-05T07:03");
  assert.match(when(new Date(2026, 9, 11, 14, 5), "en-US"), /14:05/);
});

test("between a minute and thirty days ahead", () => {
  const now = new Date(2026, 9, 11, 12, 0);
  const at = (ms: number) => new Date(now.getTime() + ms);
  assert.ok(!acceptable(at(30_000), now));
  assert.ok(acceptable(at(60_000), now));
  assert.ok(acceptable(at(30 * 86_400_000), now));
  assert.ok(!acceptable(at(31 * 86_400_000), now));
  assert.ok(!acceptable(new Date("not a date"), now));
});

test("a room's own, soonest first", () => {
  const message = (id: string, room: string, at: string) =>
    ({ id, room_id: room, text: id, send_at: at, state: "pending" }) as never;
  const list = [
    message("b", "r", "2026-10-12T10:00:00Z"),
    message("x", "other", "2026-10-12T09:00:00Z"),
    message("a", "r", "2026-10-12T08:00:00Z"),
  ];
  assert.deepEqual(
    forRoom(list, "r").map((m: { id: string }) => m.id),
    ["a", "b"],
  );
});
