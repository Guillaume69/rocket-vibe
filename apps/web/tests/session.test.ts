import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "../src/api.ts";
import { logoutSession, renew } from "../src/session.ts";
import { all, purge, read, write, type Account } from "../src/store.ts";
import type { App } from "../src/app.ts";
import { deferred, memoryIndexedDB } from "./storage.ts";
globalThis.indexedDB = memoryIndexedDB();
const locks = new Map<string, Promise<unknown>>();
const lockManager = {
  request<T>(name: string, work: () => Promise<T>): Promise<T> {
    const pending = (locks.get(name) || Promise.resolve()).then(work);
    locks.set(
      name,
      pending.catch(() => {}),
    );
    return pending;
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: lockManager },
  configurable: true,
});
function fixture() {
  const account: Account = {
    key: "session-fixture",
    instance: "instance",
    epoch: "epoch",
    session: {
      token: "fixture-predecessor",
      user: { id: "user", username: "fixture", display_name: "Fixture" },
      expires_at: new Date(Date.now() + 1000).toISOString(),
    },
  };
  const notices: unknown[] = [];
  const app = {
    account,
    api: new Api(),
    generation: 1,
    info: { capabilities: { session_rotation: true } },
    channel: { postMessage: (notice: unknown) => notices.push(notice) },
    async stop() {
      app.generation++;
      app.account = undefined;
      app.api.token = "";
    },
    async expire() {
      await app.stop(true);
      await purge(account.key);
    },
  } as unknown as App;
  app.api.token = account.session.token;
  return { app, account, notices };
}
test("logout waits for rotation and revokes its committed successor", async (context) => {
  const { app, account, notices } = fixture(),
    committed = deferred<void>(),
    response = deferred<void>();
  let serverToken = account.session.token,
    logouts = 0;
  context.mock.method(globalThis, "fetch", async (path, init) => {
    if (path === "/api/v1/auth/renew") {
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer " + serverToken,
      );
      serverToken = JSON.parse(init.body).next_token;
      committed.resolve();
      await response.promise;
      return Response.json({
        ...account.session,
        token: serverToken,
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
    }
    if (path === "/.well-known/rocketvibe")
      return Response.json({ instance_id: "instance", data_epoch: "epoch" });
    assert.equal(path, "/api/v1/auth/logout");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer " + serverToken,
    );
    logouts++;
    serverToken = "";
    return new Response(null, { status: 204 });
  });
  await write("accounts", account.key, account);
  const rotating = renew(app);
  await committed.promise;
  const signingOut = logoutSession(app);
  await Promise.resolve();
  assert.equal(logouts, 0);
  response.resolve();
  await rotating;
  assert.equal(await signingOut, true);
  assert.equal(logouts, 1);
  assert.equal(serverToken, "");
  assert.equal(app.account, undefined);
  assert.equal(await read("accounts", account.key), undefined);
  assert.equal(await read("operations", account.key + ":renew"), undefined);
  assert.deepEqual(notices.at(-1), { purged: account.key });
});
test("logout recovers a durable successor after a lost rotation response", async (context) => {
  const { app, account } = fixture(),
    successor = "1".repeat(64);
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (path, init) => {
    paths.push(path);
    if (path !== "/.well-known/rocketvibe")
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer " + successor,
      );
    if (path === "/api/v1/me") return Response.json(account.session.user);
    if (path === "/api/v1/me/sessions")
      return Response.json([
        {
          current: true,
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        },
      ]);
    if (path === "/.well-known/rocketvibe")
      return Response.json({ instance_id: "instance", data_epoch: "epoch" });
    assert.equal(path, "/api/v1/auth/logout");
    return new Response(null, { status: 204 });
  });
  await write("accounts", account.key, account);
  await write("operations", account.key + ":renew", {
    operation_id: "accepted",
    next_token: successor,
  });
  await write("media", account.key + ":private", {
    account: account.key,
    room: "private",
    blob: new Blob(["private bytes"]),
  });
  assert.equal(await logoutSession(app), true);
  assert.deepEqual(paths, [
    "/api/v1/me",
    "/api/v1/me/sessions",
    "/.well-known/rocketvibe",
    "/api/v1/auth/logout",
  ]);
  assert.equal((await all("accounts")).length, 0);
  assert.equal((await all("operations")).length, 0);
  assert.equal((await all("media")).length, 0);
});
test("an expiring session without a rotation intent is revoked directly", async (context) => {
  const { app, account } = fixture();
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (path) => {
    requests++;
    assert.equal(path, "/api/v1/auth/logout");
    return new Response(null, { status: 204 });
  });
  await write("accounts", account.key, account);
  assert.equal(await logoutSession(app), true);
  assert.equal(requests, 1);
  assert.equal((await all("accounts")).length, 0);
});
test("a queued renewal cannot restore the account after locked logout", async (context) => {
  const { app, account } = fixture(),
    started = deferred<void>(),
    response = deferred<void>();
  account.session.expires_at = new Date(
    Date.now() + 30 * 86400000,
  ).toISOString();
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (path) => {
    requests++;
    assert.equal(path, "/api/v1/auth/logout");
    started.resolve();
    await response.promise;
    return new Response(null, { status: 204 });
  });
  await write("accounts", account.key, account);
  const signingOut = logoutSession(app);
  await started.promise;
  const rotating = renew(app);
  response.resolve();
  assert.equal(await signingOut, true);
  await rotating;
  assert.equal(requests, 1);
  assert.equal((await all("accounts")).length, 0);
  assert.equal((await all("operations")).length, 0);
});
test("offline logout reports unconfirmed revocation and purges local secrets", async (context) => {
  const { app, account } = fixture();
  app.info!.capabilities.session_rotation = false;
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("offline");
  });
  await write("accounts", account.key, account);
  await write("operations", account.key + ":intent", {
    token: "fixture-private-intent",
  });
  assert.equal(await logoutSession(app), false);
  assert.equal(app.account, undefined);
  assert.equal((await all("accounts")).length, 0);
  assert.equal((await all("operations")).length, 0);
});
