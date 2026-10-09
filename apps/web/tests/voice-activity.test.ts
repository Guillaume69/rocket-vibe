import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceActivity,
  LOCAL_SPEECH_DB,
  REMOTE_SPEECH_DB,
} from "../src/voice-activity.ts";
test("a remote whisper uses the GTK threshold and a 350 ms speaking hangover", () => {
  const activity = new VoiceActivity();
  activity.update(10 ** (-51 / 20), REMOTE_SPEECH_DB, 100);
  assert.equal(activity.speaking(100), true);
  assert.equal(activity.speaking(449), true);
  assert.equal(activity.speaking(450), false);
  assert.ok(Math.abs(activity.level - 0.15) < 0.001);
});
test("the meter rises immediately, decays with the desktop scale, and mute clears it", () => {
  const activity = new VoiceActivity();
  activity.update(0.1, LOCAL_SPEECH_DB, 0);
  assert.ok(Math.abs(activity.level - 2 / 3) < 0.001);
  activity.update(0, LOCAL_SPEECH_DB, 50);
  assert.ok(activity.level > 0 && activity.level < 0.23);
  activity.quiet();
  assert.equal(activity.level, 0);
  assert.equal(activity.speaking(51), false);
});
test("silence, a low noise floor and non-finite samples never activate speaking", () => {
  for (const sample of [0, NaN, Infinity, 10 ** (-60 / 20)]) {
    const activity = new VoiceActivity();
    activity.update(sample, REMOTE_SPEECH_DB, 100);
    assert.equal(activity.speaking(100), false);
    assert.equal(activity.level, 0);
  }
});
