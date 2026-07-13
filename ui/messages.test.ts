import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CATALOGUES, LANGUES, langueAppareil, traduire } from './messages.ts';

describe('traduire', () => {
  test('substitue les {param}', () => {
    assert.equal(traduire('fr', 'ligneMessage.profilDe', { nom: 'alice' }), 'Profil de alice');
    assert.equal(traduire('en', 'ligneMessage.profilDe', { nom: 'alice' }), 'Profile of alice');
  });

  test('un {param} sans valeur est laissé tel quel (repérer un oubli)', () => {
    assert.equal(traduire('fr', 'ligneMessage.profilDe'), 'Profil de {nom}');
  });

  test('pluriel FR : singulier pour 0 et 1, pluriel dès 2', () => {
    assert.equal(traduire('fr', 'ligneMessage.reponses', { n: 0 }), '0 réponse');
    assert.equal(traduire('fr', 'ligneMessage.reponses', { n: 1 }), '1 réponse');
    assert.equal(traduire('fr', 'ligneMessage.reponses', { n: 2 }), '2 réponses');
  });

  test('pluriel EN : singulier pour 1 seulement (0 au pluriel)', () => {
    assert.equal(traduire('en', 'ligneMessage.reponses', { n: 0 }), '0 replies');
    assert.equal(traduire('en', 'ligneMessage.reponses', { n: 1 }), '1 reply');
    assert.equal(traduire('en', 'ligneMessage.reponses', { n: 2 }), '2 replies');
  });
});

describe('catalogue', () => {
  test('les deux langues ont EXACTEMENT les mêmes clés', () => {
    // Le type l'impose déjà à la compilation ; ce test le prouve à l'exécution
    // et attrape une éventuelle divergence introduite par un cast forcé.
    const clesFr = Object.keys(CATALOGUES.fr).sort();
    const clesEn = Object.keys(CATALOGUES.en).sort();
    assert.deepEqual(clesEn, clesFr);
  });

  test('aucune valeur vide', () => {
    for (const langue of LANGUES) {
      for (const [cle, valeur] of Object.entries(CATALOGUES[langue])) {
        assert.notEqual(valeur.trim(), '', `${langue}/${cle} est vide`);
      }
    }
  });
});

describe('langueAppareil', () => {
  test('rend une langue couverte, jamais autre chose', () => {
    assert.ok(LANGUES.includes(langueAppareil()));
  });
});
