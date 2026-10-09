import { test } from "node:test";
import assert from "node:assert/strict";
import { flushUploads, type UploadJob } from "../src/uploads.ts";
import { all, Model, purge, purgeRoom, write } from "../src/store.ts";
import type { App } from "../src/app.ts";
import type { Message, Room } from "../src/protocol.ts";
import { deferred, memoryIndexedDB } from "./storage.ts";
globalThis.indexedDB = memoryIndexedDB();
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
});
function fixture() {
  const job: UploadJob = {
    id: "prepare",
    account: "uploads-fixture",
    room: "private",
    membership: "one",
    caption: "old grant",
    complete: "complete",
    file: new File(["private bytes"], "private.txt", { type: "text/plain" }),
  };
  const model = new Model();
  model.rooms.set("private", {
    id: "private",
    read_state: { membership_version: "one" },
  } as Room);
  const calls: string[] = [];
  const app = {
    account: { key: job.account },
    generation: 1,
    model,
    api: {
      async request(path: string) {
        calls.push(path);
        if (path.endsWith("/complete"))
          return {
            id: "message",
            room_id: "private",
            revision: "1",
            position: "1",
          } as Message;
        return { id: "slot", state: "prepared" };
      },
      async upload() {
        calls.push("bytes");
      },
    },
    uploadProgress: new Map(),
    renderUploads() {},
    refresh() {},
    async loadUploads() {},
  } as unknown as App;
  return { app, job, calls };
}
async function withdraw(app: App, job: UploadJob) {
  app.model.rooms.get(job.room)!.read_state!.membership_version = "two";
  await purgeRoom(job.account, job.room);
}
test("a grant change during hashing cannot send or recreate a purged upload", async (context) => {
  const { app, job, calls } = fixture(),
    hashing = deferred<ArrayBuffer>(),
    started = deferred<void>();
  context.mock.method(crypto.subtle, "digest", async () => {
    started.resolve();
    return hashing.promise;
  });
  await write("uploads", job.account + ":" + job.id, job);
  const work = flushUploads(app);
  await started.promise;
  await withdraw(app, job);
  hashing.resolve(new Uint8Array(32).buffer);
  await work;
  assert.deepEqual(calls, []);
  assert.equal((await all("uploads")).length, 0);
  assert.equal(app.model.messages.size, 0);
});
test("a late upload preparation cannot restore a job after access withdrawal", async () => {
  const { app, job, calls } = fixture(),
    preparation = deferred<{ id: string; state: string }>(),
    started = deferred<void>();
  app.api.request = async () => {
    calls.push("prepare");
    started.resolve();
    return preparation.promise as never;
  };
  await write("uploads", job.account + ":" + job.id, job);
  const work = flushUploads(app);
  await started.promise;
  await withdraw(app, job);
  preparation.resolve({ id: "slot", state: "prepared" });
  await work;
  assert.deepEqual(calls, ["prepare"]);
  assert.equal((await all("uploads")).length, 0);
});
test("access withdrawal while bytes fail does not recreate or complete the upload", async () => {
  const { app, job, calls } = fixture(),
    transfer = deferred<void>(),
    started = deferred<void>();
  app.api.upload = async () => {
    calls.push("bytes");
    started.resolve();
    return transfer.promise;
  };
  await write("uploads", job.account + ":" + job.id, job);
  const work = flushUploads(app);
  await started.promise;
  await withdraw(app, job);
  transfer.reject(new TypeError("connection interrupted"));
  await work;
  assert.deepEqual(calls, ["/api/v1/uploads", "bytes"]);
  assert.equal((await all("uploads")).length, 0);
});
test("a late completion cannot restore private history after access withdrawal", async () => {
  const { app, job, calls } = fixture(),
    completion = deferred<Message>(),
    started = deferred<void>();
  const request = app.api.request.bind(app.api);
  app.api.request = async (path, ...args) => {
    if (!path.endsWith("/complete")) return request(path, ...args);
    calls.push("complete");
    started.resolve();
    return completion.promise as never;
  };
  await write("uploads", job.account + ":" + job.id, job);
  const work = flushUploads(app);
  await started.promise;
  await withdraw(app, job);
  completion.resolve({
    id: "private-message",
    room_id: job.room,
    revision: "1",
  } as Message);
  await work;
  assert.equal(app.model.messages.size, 0);
  assert.equal((await all("uploads")).length, 0);
  await purge(job.account);
});
