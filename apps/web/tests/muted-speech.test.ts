import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MutedSpeechReminder,
  MutedMicrophoneMonitor,
} from "../src/muted-speech.ts";
test("sustained speech, one reminder per burst, silence, unmute and cooldown", () => {
  const r = new MutedSpeechReminder();
  assert.equal(r.update(false, true, 0), false);
  assert.equal(r.update(true, false, 1000), false);
  assert.equal(r.update(true, true, 2000), false);
  assert.equal(r.update(true, true, 2599), false);
  assert.equal(r.update(true, true, 2600), true);
  assert.equal(r.update(true, true, 20_000), false);
  r.update(true, false, 20_001);
  r.update(true, true, 20_002);
  assert.equal(r.update(true, true, 20_602), true);
  r.update(false, true, 21_000);
  r.update(true, true, 22_000);
  assert.equal(r.update(true, true, 22_600), false);
  assert.equal(r.update(true, true, 30_602), true);
});
test("late microphone capture stops after leave without building an audio graph", async () => {
  let finish!: (stream: MediaStream) => void;
  let stopped = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            finish = resolve;
          }),
      },
    },
  });
  try {
    const monitor = new MutedMicrophoneMonitor();
    const context = {
      state: "running",
      createMediaStreamSource() {
        throw Error("stale capture must never connect");
      },
    } as unknown as AudioContext;
    const starting = monitor.start(context, "default", () => true);
    monitor.stop();
    finish({
      getTracks: () => [
        {
          stop() {
            stopped++;
          },
        },
      ],
    } as unknown as MediaStream);
    await starting;
    assert.equal(stopped, 1);
    assert.equal(monitor.rms(), 0);
    assert.equal(monitor.uses("default"), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("denied monitoring does not retry the same input until stopped or changed", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          throw new Error("permission denied");
        },
      },
    },
  });
  try {
    const monitor = new MutedMicrophoneMonitor();
    await monitor.start(
      { state: "running" } as AudioContext,
      "default",
      () => true,
    );
    assert.equal(monitor.uses("default"), true);
    assert.equal(monitor.rms(), 0);
    monitor.stop();
    assert.equal(monitor.uses("default"), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
