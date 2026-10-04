import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createDeferredDraft, DRAFT_DELAY_MS } from './deferredDraft.ts';

/** Horloge à main : rien ne part tant qu'on ne fait pas avancer le temps. */
function horloge() {
  const programmees = new Map<number, () => void>();
  const delais: number[] = [];
  let prochaine = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      delais.push(ms);
      const id = prochaine++;
      programmees.set(id, fn);
      return id;
    },
    cancel: (id: unknown) => void programmees.delete(id as number),
    /** Fait tirer toutes les minuteries armées. */
    tirer: () => {
      const fns = [...programmees.values()];
      programmees.clear();
      for (const fn of fns) fn();
    },
    armees: () => programmees.size,
    delais,
  };
}

/** Une instance instrumentée : `journal` note écritures et suppressions. */
function faire(delaiMs?: number) {
  const h = horloge();
  const journal: string[] = [];
  const differe = createDeferredDraft({
    write: (texte) => void journal.push(`ecrit:${texte}`),
    delete: () => void journal.push('supprime'),
    timeoutMs: delaiMs,
    schedule: h.schedule,
    cancel: h.cancel,
  });
  return { h, journal, differe };
}

describe('creerBrouillonDifferre', () => {
  test('une frappe → UNE écriture, après la pause — jamais pendant', () => {
    const { h, journal, differe } = faire();
    differe.save('bonjou');
    assert.deepEqual(journal, [], 'rien ne part pendant la frappe');
    assert.deepEqual(h.delais, [DRAFT_DELAY_MS], 'la pause par défaut est celle du contrat');
    h.tirer();
    assert.deepEqual(journal, ['ecrit:bonjou']);
  });

  test('deux frappes rapprochées → une seule écriture, la DERNIÈRE', () => {
    const { h, journal, differe } = faire();
    differe.save('bonjou');
    differe.save('bonjour');
    assert.equal(h.armees(), 1, 'la première minuterie est annulée, pas empilée');
    h.tirer();
    assert.deepEqual(journal, ['ecrit:bonjour']);
  });

  test('un texte BLANC vaut suppression, pas écriture d’espaces', () => {
    const { h, journal, differe } = faire();
    differe.save('   ');
    h.tirer();
    assert.deepEqual(journal, ['supprime']);
  });

  test('flusher pendant la pause → écriture IMMÉDIATE, et plus rien derrière', () => {
    // Le démontage de l'écran : sans ce flush, les derniers caractères tapés
    // seraient perdus.
    const { h, journal, differe } = faire();
    differe.save('à ne pas perdre');
    differe.flusher();
    assert.deepEqual(journal, ['ecrit:à ne pas perdre']);
    h.tirer();
    assert.deepEqual(journal, ['ecrit:à ne pas perdre'], 'la minuterie annulée ne retire pas');
  });

  test('flusher APRÈS le tir n’écrit pas deux fois, flusher à vide n’écrit rien', () => {
    const { h, journal, differe } = faire();
    differe.flusher();
    assert.deepEqual(journal, [], 'rien en pause, rien à écrire');
    differe.save('déjà écrit');
    h.tirer();
    differe.flusher();
    assert.deepEqual(journal, ['ecrit:déjà écrit'], 'le texte parti ne se rejoue pas');
  });

  test('effacer → suppression immédiate, la frappe en pause ne part JAMAIS', () => {
    // L'envoi du message : le brouillon n'a plus lieu d'être, débounce compris.
    const { h, journal, differe } = faire();
    differe.save('envoyé entre-temps');
    differe.clear();
    assert.deepEqual(journal, ['supprime']);
    h.tirer();
    assert.deepEqual(journal, ['supprime']);
  });

  test('changement de clé : le flush de l’ANCIENNE instance écrit chez elle, la nouvelle reste vierge', () => {
    // Le contrat sur lequel `useBrouillon` s'appuie : une instance PAR clé,
    // flush de l'ancienne au changement (cleanup d'effet). Le texte tapé dans
    // le salon A quitté en moins de 400 ms atterrit sous A — jamais sous B.
    const h = horloge();
    const parCle: Record<string, string[]> = { A: [], B: [] };
    const instance = (cle: 'A' | 'B') =>
      createDeferredDraft({
        write: (texte) => void parCle[cle].push(`ecrit:${texte}`),
        delete: () => void parCle[cle].push('supprime'),
        schedule: h.schedule,
        cancel: h.cancel,
      });

    const ancienne = instance('A');
    ancienne.save('tapé dans A');
    // Le hook bascule sur B : cleanup → flush de A, instance neuve pour B.
    ancienne.flusher();
    const nouvelle = instance('B');
    h.tirer();
    assert.deepEqual(parCle.A, ['ecrit:tapé dans A']);
    assert.deepEqual(parCle.B, [], 'rien ne fuit vers la nouvelle clé');
    nouvelle.flusher();
    assert.deepEqual(parCle.B, [], 'la nouvelle n’a rien en pause à flusher');
  });

  test('la pause est configurable — le hook garde 400 ms, un autre écran peut serrer', () => {
    const { h, differe } = faire(120);
    differe.save('x');
    assert.deepEqual(h.delais, [120]);
  });
});
