import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  imageCompressible,
  compressionOffered,
  IMAGE_COMPRESSION_THRESHOLD_BYTES,
  videoCompressible,
} from './attachmentQuality.ts';

describe('reductionProposable', () => {
  test('une image au-delà du seuil est réductible, une légère non', () => {
    assert.equal(
      compressionOffered({ type: 'image/jpeg', size: IMAGE_COMPRESSION_THRESHOLD_BYTES + 1 }),
      true,
    );
    assert.equal(
      compressionOffered({ type: 'image/jpeg', size: IMAGE_COMPRESSION_THRESHOLD_BYTES }),
      false,
    );
  });

  test("le GIF n'est jamais réduit : le JPEG tuerait l'animation", () => {
    assert.equal(compressionOffered({ type: 'image/gif', size: 5_000_000 }), false);
  });

  test('une image de poids inconnu passe telle quelle', () => {
    assert.equal(imageCompressible({ type: 'image/png', size: null }), false);
  });

  test('une vidéo est toujours réductible, même de poids inconnu ou modeste', () => {
    assert.equal(videoCompressible({ type: 'video/mp4', size: null }), true);
    assert.equal(compressionOffered({ type: 'video/quicktime', size: 300_000 }), true);
  });

  test("ni l'audio ni un document ne proposent de choix de qualité", () => {
    assert.equal(compressionOffered({ type: 'audio/mp4', size: 9_000_000 }), false);
    assert.equal(compressionOffered({ type: 'application/pdf', size: 9_000_000 }), false);
  });
});
