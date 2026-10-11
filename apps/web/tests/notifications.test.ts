import assert from "node:assert/strict";
import test from "node:test";
import {
  fitSize,
  noteActions,
  parseClick,
  within,
} from "../src/notifications.ts";

const labels = {
  read: "Mark as read",
  like: "Like",
  reply: "Reply",
  placeholder: "Reply…",
};

test("buttons: read and like first, inline reply only when the worker reads it back", () => {
  assert.deepEqual(
    noteActions(2, { inlineReply: true }, labels).map((a) => a.action),
    ["read", "like"],
  );
  const three = noteActions(3, { inlineReply: true }, labels);
  assert.deepEqual(
    three.map((a) => a.action),
    ["read", "like", "reply"],
  );
  assert.equal(three[2].type, "text");
  assert.equal(three[2].placeholder, "Reply…");
  assert.deepEqual(
    noteActions(3, { inlineReply: false }, labels).map((a) => a.action),
    ["read", "like"],
  );
  assert.deepEqual(noteActions(0, { inlineReply: true }, labels), []);
  assert.deepEqual(noteActions(Number.NaN, { inlineReply: true }, labels), []);
});

test("a click message is checked field by field", () => {
  const good = {
    type: "rv-notification",
    action: "read",
    reply: null,
    account: "a",
    room: "r",
    message: "m",
  };
  assert.deepEqual(parseClick(good), good);
  assert.equal(parseClick({ ...good, action: "delete" }), undefined);
  assert.equal(parseClick({ ...good, room: 3 }), undefined);
  assert.equal(parseClick({ ...good, reply: 1 }), undefined);
  assert.equal(parseClick({ ...good, type: "other" }), undefined);
  assert.equal(parseClick("rv-notification"), undefined);
  assert.equal(parseClick(null), undefined);
  assert.deepEqual(
    parseClick({ ...good, action: "reply", reply: "hi" })?.reply,
    "hi",
  );
});

test("pictures are fitted, never enlarged", () => {
  const box = { width: 720, height: 720 };
  assert.deepEqual(fitSize({ width: 1440, height: 720 }, box), {
    width: 720,
    height: 360,
  });
  assert.deepEqual(fitSize({ width: 300, height: 4000 }, box), {
    width: 54,
    height: 720,
  });
  assert.deepEqual(fitSize({ width: 100, height: 50 }, box), {
    width: 100,
    height: 50,
  });
  assert.deepEqual(fitSize({ width: 0, height: 0 }, box), {
    width: 1,
    height: 1,
  });
});

test("a slow or failed picture gives way", async () => {
  assert.equal(await within(Promise.resolve("x"), 50), "x");
  assert.equal(await within(Promise.reject(new Error("no")), 50), undefined);
  assert.equal(
    await within(
      new Promise((resolve) => setTimeout(resolve, 500, "late")),
      20,
    ),
    undefined,
  );
});
