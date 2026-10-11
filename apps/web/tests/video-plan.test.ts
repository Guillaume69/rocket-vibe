import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_BITRATE,
  VIDEO_MIN_BITRATE,
  keepReduced,
  reducedName,
  reductionPlan,
  targetDimensions,
  videoReducible,
} from "../src/video-plan.ts";

test("every non-empty video is a reduction candidate, nothing else", () => {
  assert.equal(videoReducible({ type: "video/mp4", size: 10 }), true);
  assert.equal(videoReducible({ type: "video/webm", size: 10 }), true);
  assert.equal(videoReducible({ type: "video/quicktime", size: 1 }), true);
  assert.equal(videoReducible({ type: "video/mp4", size: 0 }), false);
  assert.equal(videoReducible({ type: "image/png", size: 10 }), false);
  assert.equal(videoReducible({ type: "audio/mp4", size: 10 }), false);
});

test("the short side is capped at 720 with the aspect kept, both even", () => {
  assert.deepEqual(targetDimensions(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(targetDimensions(1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(targetDimensions(3840, 2160), { width: 1280, height: 720 });
  assert.deepEqual(targetDimensions(1600, 900), { width: 1280, height: 720 });
  // 4:3 and an odd ratio: the long side follows, rounded to even.
  assert.deepEqual(targetDimensions(1440, 1080), { width: 960, height: 720 });
  assert.deepEqual(targetDimensions(2000, 999), { width: 1442, height: 720 });
  // Within 720p nothing grows; odd sizes become even for the encoder.
  assert.deepEqual(targetDimensions(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(targetDimensions(641, 361), { width: 642, height: 362 });
  assert.deepEqual(targetDimensions(720, 720), { width: 720, height: 720 });
  assert.deepEqual(targetDimensions(1000, 1000), { width: 720, height: 720 });
});

test("the plan re-encodes big or heavy videos at most at 2 Mbps", () => {
  // 1080p at 10 Mbps: resized, the mobile bitrate.
  assert.deepEqual(
    reductionPlan({
      width: 1920,
      height: 1080,
      duration: 10,
      bytes: 12_500_000,
    }),
    { width: 1280, height: 720, bitrate: VIDEO_BITRATE },
  );
  // 720p at 8 Mbps: same size, re-encoded for the bitrate.
  assert.deepEqual(
    reductionPlan({
      width: 1280,
      height: 720,
      duration: 10,
      bytes: 10_000_000,
    }),
    { width: 1280, height: 720, bitrate: VIDEO_BITRATE },
  );
  // 1080p at 1.2 Mbps: resized, never above the source's own average.
  assert.deepEqual(
    reductionPlan({
      width: 1920,
      height: 1080,
      duration: 10,
      bytes: 1_500_000,
    }),
    { width: 1280, height: 720, bitrate: 1_200_000 },
  );
  // A starved 1080p: the floor.
  assert.deepEqual(
    reductionPlan({ width: 1920, height: 1080, duration: 10, bytes: 100_000 }),
    { width: 1280, height: 720, bitrate: VIDEO_MIN_BITRATE },
  );
  // Unknown duration: resize at the target bitrate.
  assert.deepEqual(
    reductionPlan({ width: 1080, height: 1920, duration: 0, bytes: 5_000_000 }),
    { width: 720, height: 1280, bitrate: VIDEO_BITRATE },
  );
});

test("a video already within 720p and about 2 Mbps is sent as is", () => {
  assert.equal(
    reductionPlan({ width: 1280, height: 720, duration: 10, bytes: 2_500_000 }),
    null,
  );
  assert.equal(
    reductionPlan({ width: 640, height: 360, duration: 4, bytes: 300_000 }),
    null,
  );
  assert.equal(
    reductionPlan({ width: 0, height: 720, duration: 4, bytes: 300_000 }),
    null,
  );
  assert.equal(
    reductionPlan({ width: NaN, height: 720, duration: 4, bytes: 300_000 }),
    null,
  );
});

test("a re-encode that is not lighter is thrown away", () => {
  assert.equal(keepReduced(1000, 999), true);
  assert.equal(keepReduced(1000, 1000), false);
  assert.equal(keepReduced(1000, 1500), false);
  assert.equal(keepReduced(1000, 0), false);
});

test("the reduced file keeps the original name as .mp4", () => {
  assert.equal(reducedName("holiday.MOV"), "holiday.mp4");
  assert.equal(reducedName("clip.webm"), "clip.mp4");
  assert.equal(reducedName("a.b.mkv"), "a.b.mp4");
  assert.equal(reducedName("noextension"), "noextension.mp4");
  assert.equal(reducedName(".webm"), "video.mp4");
});
