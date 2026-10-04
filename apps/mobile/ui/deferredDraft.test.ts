import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { creerBrouillonDifferre, DELAI_BROUILLON_MS } from './deferredDraft.ts';

/** Horloge à main : rien ne part tant qu'on ne fait pas avancer le temps. */
function horloge() {
  const programmees = new Map<number, () => void>();
  const delais: number[] = [];
  let prochaine = 1;
  return {
    programmer: (fn: () => void, ms: number) => {
      delais.push(ms);
      const id = prochaine++;
      programmees.set(id, fn);
      return id;
    },
    annuler: (id: unknown) => void programmees.delete(id as number),
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
  const differe = creerBrouillonDifferre({
    ecrire: (texte) => void journal.push(`ecrit:${texte}`),
    supprimer: () => void journal.push('supprime'),
    delaiMs,
    programmer: h.programmer,
    annuler: h.annuler,
  });
  return { h, journal, differe };
}

describe('creerBrouillonDifferre', () => {
  test('une frappe → UNE écriture, après la pause — jamais pendant', () => {
    const { h, journal, differe } = faire();
    differe.sauver('bonjou');
    assert.deepEqual(journal, [], 'rien ne part pendant la frappe');
    assert.deepEqual(h.delais, [DELAI_BROUILLON_MS], 'la pause par défaut est celle du contrat');
    h.tirer();
    assert.deepEqual(journal, ['ecrit:bonjou']);
  });

  test('deux frappes rapprochées → une seule écriture, la DERNIÈRE', () => {
    const { h, journal, differe } = faire();
    differe.sauver('bonjou');
    differe.sauver('bonjour');
    assert.equal(h.armees(), 1, 'la première minuterie est annulée, pas empilée');
    h.tirer();
    assert.deepEqual(journal, ['ecrit:bonjour']);
  });

  test('un texte BLANC vaut suppression, pas écriture d’espaces', () => {
    const { h, journal, differe } = faire();
    differe.sauver('   ');
    h.tirer();
    assert.deepEqual(journal, ['supprime']);
  });

  test('flusher pendant la pause → écriture IMMÉDIATE, et plus rien derrière', () => {
    // Le démontage de l'écran : sans ce flush, les derniers caractères tapés
    // seraient perdus.
    const { h, journal, differe } = faire();
    differe.sauver('à ne pas perdre');
    differe.flusher();
    assert.deepEqual(journal, ['ecrit:à ne pas perdre']);
    h.tirer();
    assert.deepEqual(journal, ['ecrit:à ne pas perdre'], 'la minuterie annulée ne retire pas');
  });

  test('flusher APRÈS le tir n’écrit pas deux fois, flusher à vide n’écrit rien', () => {
    const { h, journal, differe } = faire();
    differe.flusher();
    assert.deepEqual(journal, [], 'rien en pause, rien à écrire');
    differe.sauver('déjà écrit');
    h.tirer();
    differe.flusher();
    assert.deepEqual(journal, ['ecrit:déjà écrit'], 'le texte parti ne se rejoue pas');
  });

  test('effacer → suppression immédiate, la frappe en pause ne part JAMAIS', () => {
    // L'envoi du message : le brouillon n'a plus lieu d'être, débounce compris.
    const { h, journal, differe } = faire();
    differe.sauver('envoyé entre-temps');
    differe.effacer();
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
      creerBrouillonDifferre({
        ecrire: (texte) => void parCle[cle].push(`ecrit:${texte}`),
        supprimer: () => void parCle[cle].push('supprime'),
        programmer: h.programmer,
        annuler: h.annuler,
      });

    const ancienne = instance('A');
    ancienne.sauver('tapé dans A');
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
    differe.sauver('x');
    assert.deepEqual(h.delais, [120]);
  });
});
