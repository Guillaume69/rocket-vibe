import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  imageCompressible,
  compressionOffered,
  IMAGE_COMPRESSION_THRESHOLD_BYTES,
  videoCompressible,
} from './attachmentQuality.ts';

describe('compressionOffered', () => {
  test('an image above the threshold is compressible, a light one is not', () => {
    assert.equal(
      compressionOffered({ type: 'image/jpeg', size: IMAGE_COMPRESSION_THRESHOLD_BYTES + 1 }),
      true,
    );
    assert.equal(
      compressionOffered({ type: 'image/jpeg', size: IMAGE_COMPRESSION_THRESHOLD_BYTES }),
      false,
    );
  });

  test("GIF is never compressed: JPEG would kill the animation", () => {
    assert.equal(compressionOffered({ type: 'image/gif', size: 5_000_000 }), false);
  });

  test('an image of unknown size passes as is', () => {
    assert.equal(imageCompressible({ type: 'image/png', size: null }), false);
  });

  test('a video is always compressible, even of unknown or modest size', () => {
    assert.equal(videoCompressible({ type: 'video/mp4', size: null }), true);
    assert.equal(compressionOffered({ type: 'video/quicktime', size: 300_000 }), true);
  });

  test("neither audio nor a document offers a quality choice", () => {
    assert.equal(compressionOffered({ type: 'audio/mp4', size: 9_000_000 }), false);
    assert.equal(compressionOffered({ type: 'application/pdf', size: 9_000_000 }), false);
  });
});
