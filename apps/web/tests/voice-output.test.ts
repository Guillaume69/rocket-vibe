import { test } from "node:test";
import assert from "node:assert/strict";
import { observeAudioOutput } from "../src/voice-output.ts";

test("an ignored SDK sink promise may reject after call teardown without a stale notice or unhandled rejection", async () => {
  let reject!: (error: Error) => void;
  const native = new Promise<void>((_, fail) => (reject = fail));
  const notices: unknown[] = [];
  let active = true;
  const context: {
    state: AudioContextState;
    setSinkId: (id: string) => Promise<void>;
  } = {
    state: "running",
    setSinkId: () => native,
  };
  observeAudioOutput(
    context,
    () => active,
    (error) => notices.push(error),
  );
  // Deliberately emulate the SDK's ignored promise, not an awaited caller.
  void context.setSinkId("default");
  active = false;
  context.state = "closed";
  reject(new Error("Cannot proceed setSinkId on a closed AudioContext."));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, []);
});

test("a current output failure remains observable to the caller and the call's notice handler", async () => {
  const failure = new Error("Output device unavailable");
  const native = Promise.reject(failure);
  const notices: unknown[] = [];
  const context = {
    state: "running" as AudioContextState,
    setSinkId: () => native,
  };
  observeAudioOutput(
    context,
    () => true,
    (error) => notices.push(error),
  );
  assert.equal(context.setSinkId(), native);
  await assert.rejects(native, failure);
  assert.deepEqual(notices, [failure]);
});

test("late output requests cannot reach a retired or closed context", async () => {
  let calls = 0;
  let active = false;
  const context = {
    state: "running" as AudioContextState,
    setSinkId: async () => {
      calls++;
    },
  };
  observeAudioOutput(context, () => active, assert.fail);
  await context.setSinkId();
  active = true;
  context.state = "closed";
  await context.setSinkId();
  assert.equal(calls, 0);
});
