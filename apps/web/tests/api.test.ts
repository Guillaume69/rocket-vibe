import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "../src/api.ts";
const rejected = () =>
  Response.json(
    { code: "session_rejected", request_id: "native-envelope" },
    { status: 401 },
  );
test("only a native authenticated rejection expires the active bearer", async (context) => {
  const api = new Api();
  api.token = "old";
  let expired = 0;
  api.expired = () => {
    expired++;
  };
  context.mock.method(globalThis, "fetch", async () => rejected());
  await assert.rejects(api.request("/api/v1/auth/start", "POST", {}, true));
  assert.equal(expired, 0);
  await assert.rejects(api.request("/api/v1/me"));
  assert.equal(expired, 1);
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "Unauthorized" }, { status: 401 }),
  );
  await assert.rejects(api.request("/api/v1/me"));
  assert.equal(expired, 1);
  context.mock.method(globalThis, "fetch", async () => {
    api.token = "new";
    return rejected();
  });
  await assert.rejects(api.request("/api/v1/me"));
  assert.equal(expired, 1);
});
test("API access never sends a bearer to a foreign origin", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  const api = new Api();
  api.token = "private";
  await assert.rejects(api.request("https://foreign.example/api/v1/me"));
  await assert.rejects(api.blob("//foreign.example/file"));
  assert.equal(calls, 0);
});
test("anonymous discovery and login omit the bearer and all requests omit cookies", async (context) => {
  const inputs: RequestInit[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      inputs.push(init!);
      return Response.json({});
    },
  );
  const api = new Api();
  api.token = "private";
  await api.request("/.well-known/rocketvibe", "GET", undefined, true);
  await api.request("/api/v1/auth/start", "POST", {}, true);
  await api.request("/api/v1/me");
  assert.equal(new Headers(inputs[0].headers).has("Authorization"), false);
  assert.equal(new Headers(inputs[1].headers).has("Authorization"), false);
  assert.equal(
    new Headers(inputs[2].headers).get("Authorization"),
    "Bearer private",
  );
  assert.ok(
    inputs.every(
      (input) => input.credentials === "omit" && input.cache === "no-store",
    ),
  );
});
