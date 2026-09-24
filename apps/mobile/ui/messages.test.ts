import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CATALOGUES,
  LANGUES,
  formateurHeure,
  formateurJour,
  langueAppareil,
  traduire,
} from './messages.ts';

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

describe('formateurHeure', () => {
  // On asserte la FORME, pas la valeur : le formateur suit le fuseau local du
  // runner, qu'on ne fige pas. Le `\s` du motif EN couvre l'espace fine
  // insécable (U+202F) qu'ICU met devant AM/PM.
  test('FR au format 24 h sur deux chiffres, EN au format 12 h AM/PM', () => {
    const ms = Date.UTC(2026, 0, 15, 14, 5, 0);
    assert.match(formateurHeure('fr')(ms), /^\d{2}:\d{2}$/u);
    assert.match(formateurHeure('en')(ms), /^\d{1,2}:\d{2}\s[AP]M$/u);
  });
});

describe('formateurJour', () => {
  // Dates construites en HEURE LOCALE (midi : loin des bords de jour) et
  // `maintenant` injecté : rien ne dépend du fuseau ni de l'horloge du runner.
  const maintenant = new Date(2026, 7, 1, 12).getTime(); // samedi 1ᵉʳ août 2026

  test("aujourd'hui et hier passent par le catalogue, pas par la date", () => {
    assert.equal(formateurJour('fr')(maintenant, maintenant), "Aujourd'hui");
    assert.equal(formateurJour('fr')(new Date(2026, 6, 31, 9).getTime(), maintenant), 'Hier');
    assert.equal(formateurJour('en')(maintenant, maintenant), 'Today');
    assert.equal(formateurJour('en')(new Date(2026, 6, 31, 9).getTime(), maintenant), 'Yesterday');
  });

  test("l'année courante porte le jour de semaine, une autre année porte l'année", () => {
    assert.equal(formateurJour('fr')(new Date(2026, 6, 30, 12).getTime(), maintenant), 'jeudi 30 juillet');
    assert.equal(formateurJour('fr')(new Date(2025, 6, 30, 12).getTime(), maintenant), '30 juillet 2025');
    assert.equal(formateurJour('en')(new Date(2026, 6, 30, 12).getTime(), maintenant), 'Thursday, July 30');
    assert.equal(formateurJour('en')(new Date(2025, 6, 30, 12).getTime(), maintenant), 'July 30, 2025');
  });
});

describe('langueAppareil', () => {
  test('rend une langue couverte, jamais autre chose', () => {
    assert.ok(LANGUES.includes(langueAppareil()));
  });
});
