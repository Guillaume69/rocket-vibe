import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Model, newer } from "../src/store.ts";
import type { App } from "../src/app.ts";
import type { ReadState, Room } from "../src/protocol.ts";

// Exercise the async lifetime boundary without initializing browser UI modules.
const source = ts.createSourceFile(
  "room-state.ts",
  readFileSync(new URL("../src/room-state.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node),
)!;
const code = ts.transpileModule(
  declaration.getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const hydrate = new Function(
  "segment",
  "newer",
  code + "; return personalizedRoom;",
)(encodeURIComponent, newer) as (
  app: App,
  room: Room,
  current: () => boolean,
) => Promise<Room | undefined>;
const receipt: Room = {
  id: "room",
  kind: "direct",
  name: "Alice / Bob",
  revision: "1",
};
const personal = (membership = "first", revision = "1"): ReadState => ({
  room_id: "room",
  membership_version: membership,
  revision,
  favorite_revision: revision,
  root_position: "0",
  reply_position: "0",
  unread_roots: "0",
  unread_replies: "0",
  mentions: "0",
  group_mentions: "0",
  favorite: false,
});
function held() {
  let release!: (state: ReadState) => void;
  const read = new Promise<ReadState>((resolve) => {
    release = resolve;
  });
  const model = new Model();
  const app = {
    account: { key: "account" },
    generation: 1,
    info: { capabilities: { read_markers: true } },
    model,
    api: { request: async () => read },
  } as unknown as App;
  return { app, model, release };
}
test("initial validated DM personalization accepts the first sync insertion", async () => {
  const { app, model, release } = held();
  const result = hydrate(app, receipt, () => true);
  model.batch({
    protocol_version: 1,
    cursor: "1",
    changes: [
      { type: "room_upsert", data: { ...receipt, read_state: personal() } },
    ],
  });
  release(personal());
  assert.equal((await result)?.read_state?.membership_version, "first");
});
test("a held personal read cannot resurrect an initially unknown room removed in the same sync batch", async () => {
  const { app, model, release } = held();
  const result = hydrate(app, receipt, () => true);
  model.batch({
    protocol_version: 1,
    cursor: "1",
    changes: [
      { type: "room_upsert", data: { ...receipt, read_state: personal() } },
      { type: "room_removed", data: { room_id: "room" } },
    ],
  });
  release(personal());
  assert.equal(await result, undefined);
  assert.equal(model.rooms.has("room"), false);
});
test("a held read from a retired membership cannot publish after a remove/rejoin", async () => {
  const { app, model, release } = held();
  model.rooms.set("room", { ...receipt, read_state: personal() });
  const result = hydrate(app, receipt, () => true);
  model.batch({
    protocol_version: 1,
    cursor: "1",
    changes: [
      { type: "room_removed", data: { room_id: "room" } },
      {
        type: "room_upsert",
        data: { ...receipt, read_state: personal("second") },
      },
    ],
  });
  release(personal());
  assert.equal(await result, undefined);
  assert.equal(
    model.rooms.get("room")?.read_state?.membership_version,
    "second",
  );
});
test("a bare creation receipt keeps newer personal state and room metadata received while its read is held", async () => {
  const { app, model, release } = held();
  model.rooms.set("room", { ...receipt, read_state: personal() });
  const result = hydrate(app, receipt, () => true);
  model.batch({
    protocol_version: 1,
    cursor: "1",
    changes: [
      {
        type: "room_upsert",
        data: {
          ...receipt,
          name: "Newer name",
          revision: "2",
          read_state: { ...personal("first", "9"), favorite: true },
        },
      },
    ],
  });
  release(personal());
  const room = await result;
  assert.equal(room?.revision, "2");
  assert.equal(room?.read_state?.revision, "9");
  assert.equal(room?.read_state?.favorite, true);
});
