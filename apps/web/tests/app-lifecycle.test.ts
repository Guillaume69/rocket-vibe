import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Model, type Pending } from "../src/store.ts";
import type { Message, Room } from "../src/protocol.ts";
import { newStep } from "../src/workflows-model.ts";

const source = ts.createSourceFile(
  "app.ts",
  readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const appClass = source.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "App",
)!;
function method(
  name: string,
  dependencies: Record<string, unknown> = {},
): Function {
  const member = appClass.members.find(
    (node) => node.name?.getText(source) === name,
  )!;
  const code = ts.transpileModule(
    "class Review {" + member.getText(source) + "}",
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  return new Function(
    ...Object.keys(dependencies),
    code + "; return Review.prototype." + name,
  )(...Object.values(dependencies));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const user = {
  id: "fixture-user",
  username: "fixture",
  display_name: "Fixture",
};
const room = (id: string, membership = "one"): Room => ({
  id,
  name: id,
  kind: "public",
  revision: "1",
  read_state: {
    room_id: id,
    membership_version: membership,
    revision: "1",
    favorite_revision: "1",
    favorite: false,
    root_position: "0",
    reply_position: "0",
    unread_roots: "0",
    unread_replies: "0",
    mentions: "0",
    group_mentions: "0",
  },
});
const message = (id: string, room_id = "A"): Message => ({
  id,
  room_id,
  revision: "1",
  position: "1",
  author: user,
  text: id,
  created_at: "2026-10-09T10:00:00Z",
});
function node() {
  return {
    value: "",
    rows: 0,
    dataset: {} as Record<string, string>,
    classList: { add() {} },
    isConnected: true,
    hidden: true,
    children: [] as unknown[],
    scrollTop: 0,
    scrollHeight: 100,
    append(...children: unknown[]) {
      this.children.push(...children);
    },
    prepend(...children: unknown[]) {
      this.children.unshift(...children);
    },
    replaceChildren(...children: unknown[]) {
      this.children = children;
    },
    querySelector(_selector: string) {
      return undefined as ReturnType<typeof node> | undefined;
    },
    addEventListener() {},
    setAttribute() {},
    remove() {},
    focus() {},
  };
}
function app() {
  const model = new Model();
  model.rooms.set("A", room("A"));
  model.rooms.set("B", room("B"));
  return {
    account: {
      key: "fixture",
      instance: "instance",
      epoch: "epoch",
      session: { user, token: "token", expires_at: "2099-01-01T00:00:00Z" },
    },
    model,
    generation: 1,
    roomOpening: 1,
    threadOpening: 0,
    room: "A",
    root: undefined as string | undefined,
    draftReady: true,
    staged: [] as File[],
    pendingCreated: 0,
    composer: { value: "send in A" },
    threadComposer: node(),
    threadPane: node(),
    quote: undefined as Message | undefined,
    replyBar: { hidden: false },
    roomPermissions: new Map(),
    assetURLs: new Map<string, Promise<string>>(),
    assetRooms: new Map<string, string>(),
    roomURLs: new Map<string, Set<string>>(),
    urls: new Set<string>(),
    roomFence: method("roomFence"),
    api: {
      request: async (
        _path: string,
        _verb?: string,
        _input?: unknown,
      ): Promise<unknown> => ({}),
    },
    flushing: false,
    flushRequested: false,
    refresh() {},
    loadPending: async () => {},
    loadEmojis: async () => {},
    serverIcon() {},
    flush: async () => {},
    channel: { postMessage() {} },
    setConnection() {},
  };
}
test("a committed room A send preserves room B's draft and quote", async () => {
  const target = app(),
    commit = deferred();
  const changes: { store: string; key: string; value?: unknown }[] = [];
  const send = method("send", {
    operation: () => "operation",
    writeBatch: async (items: typeof changes, active: () => boolean) => {
      if (!active()) return false;
      changes.push(...items);
      await commit.promise;
      return true;
    },
  });
  const work = send.call(target);
  target.room = "B";
  target.roomOpening++;
  target.composer.value = "unsent in B";
  target.quote = message("B-quote", "B");
  commit.resolve(undefined);
  await work;
  assert.equal(target.composer.value, "unsent in B");
  assert.equal(target.quote?.id, "B-quote");
  assert.equal(target.replyBar.hidden, false);
  assert.ok(changes.every((change) => change.key.startsWith("fixture:")));
  assert.equal(
    changes.find((change) => change.store === "drafts")?.key,
    "fixture:A",
  );
  assert.equal((changes[0].value as Pending).room, "A");
});
test("a send preserves text and a new quote typed during the same-room commit", async () => {
  const target = app(),
    commit = deferred();
  target.quote = message("initial-quote");
  let saved: Pending | undefined;
  const send = method("send", {
    operation: () => "operation",
    writeBatch: async (
      changes: { value?: unknown }[],
      active: () => boolean,
    ) => {
      if (!active()) return false;
      saved = changes[0].value as Pending;
      await commit.promise;
      return true;
    },
  });
  const work = send.call(target);
  target.composer.value = "next draft";
  target.quote = message("next-quote");
  commit.resolve(undefined);
  await work;
  assert.equal(target.composer.value, "next draft");
  assert.equal(target.quote?.id, "next-quote");
  assert.equal(saved?.payload.quotes?.[0].message_id, "initial-quote");
});
test("a send cannot persist after its membership changes before transaction creation", async () => {
  const target = app(),
    transaction = deferred();
  let saved = false;
  const send = method("send", {
    operation: () => "operation",
    writeBatch: async (_changes: unknown, active: () => boolean) => {
      await transaction.promise;
      saved = active();
      return saved;
    },
  });
  const work = send.call(target);
  target.model.rooms.set("A", room("A", "two"));
  transaction.resolve(undefined);
  await work;
  assert.equal(saved, false);
  assert.equal(target.composer.value, "send in A");
});
function pending(id: string, created: string): Pending {
  return {
    id,
    created,
    account: "fixture",
    room: "A",
    membership: "one",
    payload: { operation_id: id, text: id },
  };
}
test("outbox replay follows creation order rather than IndexedDB UUID key order", async () => {
  const target = app(),
    sent: string[] = [];
  const flush = method("flush", {
    navigator: { onLine: true },
    all: async () => [
      pending("0-second", "2026-10-09T10:00:01Z"),
      pending("f-first", "2026-10-09T10:00:00Z"),
    ],
    write: async () => {},
    segment: encodeURIComponent,
  });
  target.api.request = async (_path, _verb, payload) => {
    sent.push((payload as Pending["payload"]).text);
    return message(sent.at(-1)!);
  };
  await flush.call(target);
  assert.deepEqual(sent, ["f-first", "0-second"]);
});
test("a flush requested by a new send while another receipt is pending runs afterward", async () => {
  const target = app(),
    first = deferred(),
    second = deferred();
  const queue = new Map([["first", pending("first", "2026-10-09T10:00:00Z")]]);
  const sent: string[] = [];
  const flush = method("flush", {
    navigator: { onLine: true },
    all: async () => structuredClone([...queue.values()]),
    write: async (_store: string, key: string) => {
      queue.delete(key.slice("fixture:".length));
    },
    segment: encodeURIComponent,
    toast: (error: unknown) => {
      throw error;
    },
  });
  target.flush = () => flush.call(target);
  target.api.request = async (_path, _verb, payload) => {
    const id = (payload as Pending["payload"]).text;
    sent.push(id);
    if (id === "first") await first.promise;
    else second.resolve(undefined);
    return message(id);
  };
  const work = target.flush();
  await Promise.resolve();
  await Promise.resolve();
  queue.set("second", pending("second", "2026-10-09T10:00:01Z"));
  await target.flush();
  first.resolve(undefined);
  await work;
  await second.promise;
  assert.deepEqual(sent, ["first", "second"]);
});
test("thread responses from an earlier room opening or membership stay out of the model", async () => {
  for (const change of ["room", "membership", "thread"] as const) {
    const target = app(),
      receipt = deferred<unknown>();
    target.api.request = () => receipt.promise;
    const thread = method("thread", { segment: encodeURIComponent });
    const work = thread.call(target, message("root-A"));
    if (change === "room") {
      target.room = "B";
      target.roomOpening++;
    } else if (change === "membership")
      target.model.rooms.set("A", room("A", "two"));
    else target.threadOpening++;
    receipt.resolve({ root: message("root-A"), messages: [], has_more: false });
    await work;
    assert.equal(target.root, undefined, change);
    assert.equal(target.model.messages.size, 0, change);
    assert.equal(target.threadPane.hidden, true, change);
  }
});
test("a delayed thread draft cannot reopen a closed thread", async () => {
  const target = app(),
    draft = deferred<string>();
  target.api.request = async () => ({
    root: message("root-A"),
    messages: [],
    has_more: false,
  });
  const thread = method("thread", {
    segment: encodeURIComponent,
    read: () => draft.promise,
  });
  const work = thread.call(target, message("root-A"));
  await Promise.resolve();
  target.threadOpening++;
  draft.resolve("private thread draft");
  await work;
  assert.equal(target.root, undefined);
  assert.equal(target.model.messages.size, 0);
});
class ApiError extends Error {
  status: number;
  constructor(status: number) {
    super("fixture");
    this.status = status;
  }
}
test("superseded initial and recovery snapshots cannot replace newer model state", async () => {
  for (const recovery of [false, true]) {
    const target = app(),
      snapshot = deferred<unknown>(),
      started = deferred();
    target.model.cursor = recovery ? "old-cursor" : "";
    target.api = {
      request: async (path: string) => {
        if (path === "/.well-known/rocketvibe")
          return { instance_id: "instance", data_epoch: "epoch" };
        if (path.startsWith("/api/v1/sync/changes")) throw new ApiError(409);
        return { preferences: { desktop_notifications: "all" } };
      },
      snapshot: async () => {
        started.resolve(undefined);
        return snapshot.promise;
      },
    } as typeof target.api;
    const reconnect = method("reconnect", {
      renew: async () => {},
      segment: encodeURIComponent,
      ApiError,
    });
    const work = reconnect.call(target);
    await started.promise;
    target.generation++;
    target.model.replace({
      protocol_version: 1,
      rooms: [room("B")],
      messages: [],
      cursor: "new-cursor",
    });
    snapshot.resolve({
      protocol_version: 1,
      rooms: [room("A")],
      messages: [],
      cursor: "stale-cursor",
    });
    await work;
    assert.deepEqual([...target.model.rooms.keys()], ["B"]);
    assert.equal(target.model.cursor, "new-cursor");
  }
});
test("a delayed profile response from another generation cannot change preferences", async () => {
  const target = {
      ...app(),
      preferences: { desktop_notifications: "nothing" },
    },
    profile = deferred<unknown>(),
    started = deferred();
  target.api.request = async (path) => {
    if (path === "/.well-known/rocketvibe")
      return { instance_id: "instance", data_epoch: "epoch" };
    started.resolve(undefined);
    return profile.promise;
  };
  const reconnect = method("reconnect", { renew: async () => {} });
  const work = reconnect.call(target);
  await started.promise;
  target.generation++;
  profile.resolve({ preferences: { desktop_notifications: "all" } });
  await work;
  assert.equal(target.preferences.desktop_notifications, "nothing");
});
test("private assets register in-flight access and discard late cache writes without creating a URL", async () => {
  for (const lateCache of [false, true]) {
    const target = app(),
      response = deferred<Blob>(),
      cache = deferred(),
      caching = deferred();
    const removed: string[] = [];
    let created = 0,
      persisted = 0;
    const urls = {
      createObjectURL: () => {
        created++;
        return "blob:fixture";
      },
      revokeObjectURL() {},
    };
    const asset = method("asset", {
      URL: urls,
      cached: async () => undefined,
      cacheMedia: async () => {
        persisted++;
        caching.resolve(undefined);
        await cache.promise;
      },
      write: async (_store: string, key: string) => {
        removed.push(key);
      },
    });
    target.api = {
      ...target.api,
      blob: () => response.promise,
    } as typeof target.api;
    const work = asset.call(
      target,
      "/api/v1/messages/root-A/previews/file",
      undefined,
      "A",
    );
    const rejected = assert.rejects(work, /Conversation no longer available/);
    assert.equal(
      target.assetRooms.get("/api/v1/messages/root-A/previews/file"),
      "A",
    );
    if (lateCache) {
      response.resolve(new Blob(["private preview"]));
      await caching.promise;
    }
    target.model.rooms.delete("A");
    const forget = method("forgetRoom", {
      document: { querySelectorAll: () => [] },
      URL: urls,
      purgeRoom: async () => {},
    });
    await forget.call(target, "A");
    if (lateCache) cache.resolve(undefined);
    else response.resolve(new Blob(["private preview"]));
    await rejected;
    assert.equal(created, 0);
    assert.equal(persisted, lateCache ? 1 : 0);
    assert.deepEqual(
      removed,
      lateCache ? ["fixture:/api/v1/messages/root-A/previews/file"] : [],
    );
    assert.equal(target.assetURLs.size, 0);
  }
});
test("a delayed edit receipt cannot repopulate a different session's model", async () => {
  const target = app(),
    receipt = deferred<unknown>();
  const editing = { ...target };
  editing.api.request = () => receipt.promise;
  const edit = method("updateMessage", {
    segment: encodeURIComponent,
  });
  const work = edit.call(
    editing,
    message("edited"),
    "1",
    "Edited content",
    "operation",
  );
  editing.generation++;
  editing.account = { ...editing.account, key: "another-fixture" };
  editing.model = new Model();
  receipt.resolve({
    ...message("edited"),
    revision: "2",
    text: "old account private content",
  });
  await work;
  assert.equal(editing.model.messages.size, 0);
});
test("new message and HTTP workflow steps expose their result name editor", () => {
  const source = ts.createSourceFile(
    "workflows.ts",
    readFileSync(new URL("../src/workflows.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (part: ts.Node) => {
    if (ts.isFunctionDeclaration(part) && part.name?.text === "drawSteps")
      declaration = part;
    ts.forEachChild(part, visit);
  };
  visit(source);
  const code = ts.transpileModule(declaration!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const kind of ["message", "http"] as const) {
    const labels: string[] = [],
      trigger = { kind: "command" as const, name: "fixture" };
    const dependencies = {
      draft: { trigger, steps: [newStep(kind, trigger, [])] },
      steps: node(),
      preferencesGroup: () => [node(), node()],
      nt: (key: string) => key,
      iconButton: () => node(),
      el: () => node(),
      roomRow: () => node(),
      hasThread: () => false,
      actionRow: () => node(),
      switchRow: () => node(),
      selectRow: () => node(),
      entryRow: (title: string) => {
        labels.push(title);
        const row = node(),
          input = node();
        row.querySelector = () => input;
        return row;
      },
    };
    new Function(...Object.keys(dependencies), code + ";drawSteps();")(
      ...Object.values(dependencies),
    );
    assert.ok(labels.includes("workflows.save_as"), kind);
  }
});
