import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  imageReductible,
  reductionProposable,
  SEUIL_REDUCTION_IMAGE_OCTETS,
  videoReductible,
} from './qualitePieceJointe.ts';

describe('reductionProposable', () => {
  test('une image au-delà du seuil est réductible, une légère non', () => {
    assert.equal(
      reductionProposable({ type: 'image/jpeg', taille: SEUIL_REDUCTION_IMAGE_OCTETS + 1 }),
      true,
    );
    assert.equal(
      reductionProposable({ type: 'image/jpeg', taille: SEUIL_REDUCTION_IMAGE_OCTETS }),
      false,
    );
  });

  test("le GIF n'est jamais réduit : le JPEG tuerait l'animation", () => {
    assert.equal(reductionProposable({ type: 'image/gif', taille: 5_000_000 }), false);
  });

  test('une image de poids inconnu passe telle quelle', () => {
    assert.equal(imageReductible({ type: 'image/png', taille: null }), false);
  });

  test('une vidéo est toujours réductible, même de poids inconnu ou modeste', () => {
    assert.equal(videoReductible({ type: 'video/mp4', taille: null }), true);
    assert.equal(reductionProposable({ type: 'video/quicktime', taille: 300_000 }), true);
  });

  test("ni l'audio ni un document ne proposent de choix de qualité", () => {
    assert.equal(reductionProposable({ type: 'audio/mp4', taille: 9_000_000 }), false);
    assert.equal(reductionProposable({ type: 'application/pdf', taille: 9_000_000 }), false);
  });
});
