import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptable,
  due,
  excerpt,
  inHours,
  pending,
  tomorrowNine,
  type Reminder,
} from "../src/reminders.ts";

const labels = { attachment: "Attachment", message: "Message" };

test("the offered times and their bounds", () => {
  const now = new Date(2026, 9, 11, 23, 30);
  assert.equal(inHours(now, 3).getTime() - now.getTime(), 3 * 3_600_000);
  const nine = tomorrowNine(now);
  assert.deepEqual(
    [nine.getDate(), nine.getHours(), nine.getMinutes()],
    [12, 9, 0],
  );
  const at = (ms: number) => new Date(now.getTime() + ms);
  assert.ok(!acceptable(at(30_000), now));
  assert.ok(acceptable(at(60_000), now));
  assert.ok(acceptable(at(365 * 86_400_000), now));
  assert.ok(!acceptable(at(366 * 86_400_000), now));
  assert.ok(!acceptable(new Date("nope"), now));
});

test("the excerpt keeps 140 characters, else names what is there", () => {
  assert.equal(excerpt("  a\n\nb  ", false, labels), "a b");
  assert.equal(excerpt("x".repeat(200), false, labels).length, 140);
  assert.equal(excerpt("", true, labels), "Attachment");
  assert.equal(excerpt(" ", false, labels), "Message");
});

test("due ones fire, a week late ones drop, the rest wait", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const reminder = (message: string, due: string): Reminder => ({
    account: "a",
    message,
    room: "r",
    room_name: "general",
    author: "Bob",
    excerpt: "hi",
    due,
    created: "2026-10-01T00:00:00Z",
  });
  const list = [
    reminder("soon", "2026-10-11T13:00:00Z"),
    reminder("now", "2026-10-11T12:00:00Z"),
    reminder("late", "2026-10-05T12:00:00Z"),
    reminder("old", "2026-10-03T12:00:00Z"),
  ];
  const { fire, drop } = due(list, now);
  assert.deepEqual(
    fire.map((r) => r.message),
    ["now", "late"],
  );
  assert.deepEqual(
    drop.map((r) => r.message),
    ["old"],
  );
  assert.deepEqual(
    pending([...list, { ...list[0]!, account: "b" }], "a").map(
      (r) => r.message,
    ),
    ["old", "late", "now", "soon"],
  );
});
