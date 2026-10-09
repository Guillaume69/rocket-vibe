import { test } from "node:test";
import assert from "node:assert/strict";
import { tileLayout } from "../src/voice-grid.ts";
import { volumeValue } from "../src/voice-audio.ts";
test("native call tiles stack at the captured GTK dimensions and center the final row", () => {
  assert.deepEqual(tileLayout(2, 832, 596), [
    { left: 156, top: 1, width: 519, height: 291 },
    { left: 156, top: 304, width: 519, height: 291 },
  ]);
  const six = tileLayout(5, 1200, 600);
  assert.equal(six[3].left, 202);
  assert.equal(six[4].left, 606);
  assert.equal(six[0].width, 392);
});
test("tile layout remains inside a narrow viewport and an empty call has no tiles", () => {
  assert.deepEqual(tileLayout(0, 400, 500), []);
  for (const count of [1, 2, 3, 8, 16])
    for (const rectangle of tileLayout(count, 320, 400)) {
      assert.ok(rectangle.left >= 0 && rectangle.top >= 0);
      assert.ok(
        rectangle.left + rectangle.width <= 320 &&
          rectangle.top + rectangle.height <= 400,
      );
    }
});
test("listening gain accepts the GTK zero to two range and rejects non-finite persisted values", () => {
  assert.equal(volumeValue(0), 0);
  assert.equal(volumeValue(1.5), 1.5);
  assert.equal(volumeValue(3), 2);
  assert.equal(volumeValue(-1), 0);
  assert.equal(volumeValue(NaN), 1);
  assert.equal(volumeValue("150"), 1);
});
