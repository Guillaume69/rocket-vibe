import assert from "node:assert/strict";
import test from "node:test";
import {
  clock,
  covers,
  minuteIn,
  minuteOf,
  nextMorning,
  quietNow,
} from "../src/quiet.ts";

const base = {
  revision: "r",
  language: "auto",
  clock_24h: true,
  push_enabled: true,
  push_mentions_only: false,
};

test("a window within a day and one across midnight", () => {
  const night = { start_minute: 1320, end_minute: 480, time_zone: "UTC" };
  assert.ok(covers(night, 1380) && covers(night, 0) && covers(night, 479));
  assert.ok(!covers(night, 480) && !covers(night, 720) && !covers(night, 1319));
  const day = { start_minute: 540, end_minute: 1020, time_zone: "UTC" };
  assert.ok(covers(day, 540) && !covers(day, 1020) && !covers(day, 480));
});

test("the window is read in its own time zone", () => {
  // 21:30 UTC is 23:30 in Paris in summer.
  const at = new Date("2026-07-01T21:30:00Z");
  assert.equal(minuteIn("UTC", at), 21 * 60 + 30);
  assert.equal(minuteIn("Europe/Paris", at), 23 * 60 + 30);
  const paris = {
    start_minute: 1380,
    end_minute: 420,
    time_zone: "Europe/Paris",
  };
  assert.ok(quietNow({ ...base, quiet_hours: paris }, at));
  assert.ok(
    !quietNow({ ...base, quiet_hours: { ...paris, time_zone: "UTC" } }, at),
  );
});

test("a mute runs until its instant", () => {
  const at = new Date("2026-07-01T12:00:00Z");
  assert.ok(quietNow({ ...base, muted_until: "2026-07-01T13:00:00Z" }, at));
  assert.ok(!quietNow({ ...base, muted_until: "2026-07-01T11:00:00Z" }, at));
  assert.ok(!quietNow(undefined, at));
});

test("clock text both ways and the next morning", () => {
  assert.equal(clock(1320), "22:00");
  assert.equal(clock(65), "01:05");
  assert.equal(minuteOf("07:30"), 450);
  assert.equal(minuteOf("24:00"), null);
  const evening = new Date(2026, 6, 1, 23, 0);
  assert.equal(nextMorning(evening).getDate(), 2);
  const early = new Date(2026, 6, 1, 6, 0);
  assert.equal(nextMorning(early).getDate(), 1);
});
