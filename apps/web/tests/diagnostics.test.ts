import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import {
  DIAGNOSTICS_KEPT,
  clearDiagnostics,
  diagnosticsText,
  note,
  noteError,
  recent,
  scrub,
} from "../src/diagnostics.ts";

const token = "a".repeat(64);

test("scrubbing removes tokens, addresses, queries and quoted content", () => {
  const text = scrub(
    "Failed /api/v1/sync/socket?ticket=" +
      token +
      ' for alice@example.com: Unexpected token, "hello Bob" is not valid JSON ' +
      token,
  );
  assert.ok(!text.includes(token));
  assert.ok(!text.includes("alice@example.com"));
  assert.ok(!text.includes("hello Bob"));
  assert.ok(text.includes("/api/v1/sync/socket"));
  assert.ok(scrub("x".repeat(500)).length <= 200);
});

test("API errors keep only their status and code", () => {
  clearDiagnostics();
  const error = new ApiError(403, "forbidden");
  error.message = "Alice cannot post in #secret-plans";
  noteError(error);
  noteError(new TypeError("Failed to fetch"));
  noteError("Shown to the user: Bob joined");
  assert.deepEqual(
    recent().map((entry) => [entry.kind, entry.text]),
    [
      ["error", "ApiError 403 forbidden"],
      ["error", "TypeError: Failed to fetch"],
    ],
  );
});

test("the ring keeps the newest entries only", () => {
  clearDiagnostics();
  for (let index = 0; index < DIAGNOSTICS_KEPT + 25; index++)
    note("connection", "state " + index);
  assert.equal(recent().length, DIAGNOSTICS_KEPT);
  assert.equal(recent()[0].text, "state 25");
});

test("the file names the app and browser, then the events", () => {
  clearDiagnostics();
  note("connection", "online");
  const text = diagnosticsText({
    version: "9.9.9",
    userAgent: "TestAgent/1",
    language: "en-US",
    online: true,
    connection: "online",
    now: new Date("2026-10-11T00:00:00Z"),
  });
  assert.match(text, /^Vibez 9\.9\.9\n/);
  assert.match(text, /User agent: TestAgent\/1/);
  assert.match(text, /connection online/);
});
