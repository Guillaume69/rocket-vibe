import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { smoothingDecision } from './smoothedData.ts';

describe('decisionLissage', () => {
  test('premier rendu (dernierRendu = 0) : la valeur passe tout de suite', () => {
    assert.deepEqual(smoothingDecision(0, 1_000_000, 200), { immediate: true });
  });

  test('assez de temps écoulé : immédiat — le lissage ne retarde pas un flux calme', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_200, 200), { immediate: true });
    assert.deepEqual(smoothingDecision(1_000, 1_500, 200), { immediate: true });
  });

  test('en pleine rafale : attendre EXACTEMENT le reste de la fenêtre', () => {
    // Rendu à t=1000, nouvelle valeur à t=1150 : il reste 50 ms de fenêtre.
    assert.deepEqual(smoothingDecision(1_000, 1_150, 200), { immediate: false, waitMs: 50 });
    // Tout juste dans la fenêtre : 200 ms pleines à attendre.
    assert.deepEqual(smoothingDecision(1_000, 1_000, 200), { immediate: false, waitMs: 200 });
  });

  test('à la frontière exacte, on publie — `>=`, pas `>`', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_200, 200), { immediate: true });
    assert.deepEqual(smoothingDecision(1_000, 1_199, 200), { immediate: false, waitMs: 1 });
  });

  test('délai nul : toujours immédiat — le lissage se débranche proprement', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_000, 0), { immediate: true });
  });
});
