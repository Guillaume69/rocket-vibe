import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import {
  logoutOutcome,
  replayLogouts,
  type LogoutQueue,
  type PendingLogout,
} from "../src/logouts.ts";

const later = new Date(Date.now() + 86_400_000).toISOString();
function queue(entries: PendingLogout[]) {
  const store = new Map(entries.map((entry) => [entry.id, entry]));
  const fake: LogoutQueue = {
    list: async () => [...store.values()],
    put: async (entry) => void store.set(entry.id, entry),
    remove: async (id) => void store.delete(id),
  };
  return { store, fake };
}

test("only an unreached server leaves a sign-out to replay", () => {
  assert.equal(logoutOutcome(new TypeError("Failed to fetch")), "retry");
  assert.equal(logoutOutcome(new DOMException("t", "TimeoutError")), "retry");
  assert.equal(logoutOutcome(new ApiError(502, "http_502")), "retry");
  assert.equal(logoutOutcome(new ApiError(503, "http_503")), "retry");
  assert.equal(logoutOutcome(new ApiError(429, "rate_limited")), "retry");
  assert.equal(logoutOutcome(new ApiError(408, "http_408")), "retry");
  // A proxy's 401 says nothing about the session.
  assert.equal(logoutOutcome(new ApiError(401, "http_401")), "retry");
  assert.equal(logoutOutcome(new ApiError(401, "session_rejected")), "settled");
  assert.equal(logoutOutcome(new ApiError(403, "forbidden")), "settled");
  assert.equal(logoutOutcome(new ApiError(400, "invalid")), "settled");
});

test("a replay that reaches the server forgets the entry", async () => {
  const { store, fake } = queue([
    { id: "a", tokens: ["token-a"], expires: later },
  ]);
  const sent: string[] = [];
  const result = await replayLogouts(fake, async (token) => {
    sent.push(token);
  });
  assert.deepEqual(sent, ["token-a"]);
  assert.deepEqual(result, { finished: 1, left: 0 });
  assert.equal(store.size, 0);
});

test("an already revoked token (401) is forgotten too", async () => {
  const { store, fake } = queue([
    { id: "a", tokens: ["token-a"], expires: later },
  ]);
  await replayLogouts(fake, async () => {
    throw new ApiError(401, "session_rejected");
  });
  assert.equal(store.size, 0);
});

test("still offline: the entry stays for the next try", async () => {
  const { store, fake } = queue([
    { id: "a", tokens: ["token-a"], expires: later },
  ]);
  const result = await replayLogouts(fake, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(result, { finished: 0, left: 1 });
  assert.deepEqual(store.get("a")?.tokens, ["token-a"]);
});

test("a settled token leaves the entry, the unreached one stays", async () => {
  const { store, fake } = queue([
    { id: "a", tokens: ["old", "successor"], expires: later },
  ]);
  await replayLogouts(fake, async (token) => {
    if (token === "old") throw new ApiError(401, "session_rejected");
    throw new ApiError(503, "http_503");
  });
  assert.deepEqual(store.get("a")?.tokens, ["successor"]);
});

test("an entry past its expiry goes without a request", async () => {
  const { store, fake } = queue([
    {
      id: "a",
      tokens: ["token-a"],
      expires: new Date(Date.now() - 1000).toISOString(),
    },
    { id: "b", tokens: [], expires: later },
    { id: "c", tokens: ["token-c"], expires: "not a date" },
  ]);
  let requests = 0;
  const result = await replayLogouts(fake, async () => {
    requests++;
  });
  assert.equal(requests, 0);
  assert.deepEqual(result, { finished: 3, left: 0 });
  assert.equal(store.size, 0);
});
