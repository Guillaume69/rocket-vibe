import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createDeferredDraft, DRAFT_DELAY_MS } from './deferredDraft.ts';

/** Horloge à main : rien ne part tant qu'on ne fait pas avancer le temps. */
function clock() {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      delays.push(ms);
      const id = next++;
      scheduled.set(id, fn);
      return id;
    },
    cancel: (id: unknown) => void scheduled.delete(id as number),
    /** Fait tirer toutes les minuteries armées. */
    fire: () => {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) fn();
    },
    armed: () => scheduled.size,
    delays,
  };
}

/** Une instance instrumentée : `journal` note écritures et suppressions. */
function make(timeoutMs?: number) {
  const h = clock();
  const log: string[] = [];
  const deferred = createDeferredDraft({
    write: (text) => void log.push(`ecrit:${text}`),
    delete: () => void log.push('supprime'),
    timeoutMs,
    schedule: h.schedule,
    cancel: h.cancel,
  });
  return { h, log, deferred };
}

describe('creerBrouillonDifferre', () => {
  test('une frappe → UNE écriture, après la pause — jamais pendant', () => {
    const { h, log, deferred } = make();
    deferred.save('bonjou');
    assert.deepEqual(log, [], 'rien ne part pendant la frappe');
    assert.deepEqual(h.delays, [DRAFT_DELAY_MS], 'la pause par défaut est celle du contrat');
    h.fire();
    assert.deepEqual(log, ['ecrit:bonjou']);
  });

  test('deux frappes rapprochées → une seule écriture, la DERNIÈRE', () => {
    const { h, log, deferred } = make();
    deferred.save('bonjou');
    deferred.save('bonjour');
    assert.equal(h.armed(), 1, 'la première minuterie est annulée, pas empilée');
    h.fire();
    assert.deepEqual(log, ['ecrit:bonjour']);
  });

  test('un texte BLANC vaut suppression, pas écriture d’espaces', () => {
    const { h, log, deferred } = make();
    deferred.save('   ');
    h.fire();
    assert.deepEqual(log, ['supprime']);
  });

  test('flusher pendant la pause → écriture IMMÉDIATE, et plus rien derrière', () => {
    // Le démontage de l'écran : sans ce flush, les derniers caractères tapés
    // seraient perdus.
    const { h, log, deferred } = make();
    deferred.save('à ne pas perdre');
    deferred.flusher();
    assert.deepEqual(log, ['ecrit:à ne pas perdre']);
    h.fire();
    assert.deepEqual(log, ['ecrit:à ne pas perdre'], 'la minuterie annulée ne retire pas');
  });

  test('flusher APRÈS le tir n’écrit pas deux fois, flusher à vide n’écrit rien', () => {
    const { h, log, deferred } = make();
    deferred.flusher();
    assert.deepEqual(log, [], 'rien en pause, rien à écrire');
    deferred.save('déjà écrit');
    h.fire();
    deferred.flusher();
    assert.deepEqual(log, ['ecrit:déjà écrit'], 'le texte parti ne se rejoue pas');
  });

  test('effacer → suppression immédiate, la frappe en pause ne part JAMAIS', () => {
    // L'envoi du message : le brouillon n'a plus lieu d'être, débounce compris.
    const { h, log, deferred } = make();
    deferred.save('envoyé entre-temps');
    deferred.clear();
    assert.deepEqual(log, ['supprime']);
    h.fire();
    assert.deepEqual(log, ['supprime']);
  });

  test('changement de clé : le flush de l’ANCIENNE instance écrit chez elle, la nouvelle reste vierge', () => {
    // Le contrat sur lequel `useBrouillon` s'appuie : une instance PAR clé,
    // flush de l'ancienne au changement (cleanup d'effet). Le texte tapé dans
    // le salon A quitté en moins de 400 ms atterrit sous A — jamais sous B.
    const h = clock();
    const byKey: Record<string, string[]> = { A: [], B: [] };
    const instance = (key: 'A' | 'B') =>
      createDeferredDraft({
        write: (text) => void byKey[key].push(`ecrit:${text}`),
        delete: () => void byKey[key].push('supprime'),
        schedule: h.schedule,
        cancel: h.cancel,
      });

    const old = instance('A');
    old.save('tapé dans A');
    // Le hook bascule sur B : cleanup → flush de A, instance neuve pour B.
    old.flusher();
    const next = instance('B');
    h.fire();
    assert.deepEqual(byKey.A, ['ecrit:tapé dans A']);
    assert.deepEqual(byKey.B, [], 'rien ne fuit vers la nouvelle clé');
    next.flusher();
    assert.deepEqual(byKey.B, [], 'la nouvelle n’a rien en pause à flusher');
  });

  test('la pause est configurable — le hook garde 400 ms, un autre écran peut serrer', () => {
    const { h, deferred } = make(120);
    deferred.save('x');
    assert.deepEqual(h.delays, [120]);
  });
});
