import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { arbreDuMessage, texteDe, unicodeDEmoji } from './markdown.ts';

describe('arbreDuMessage', () => {
  test('préfère le `md` du serveur quand il est présent', () => {
    const md = JSON.stringify([
      { type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: 'serveur' }] },
    ]);
    const arbre = arbreDuMessage(md, 'texte ignoré');
    assert.equal(texteDe(arbre), 'serveur');
  });

  test('un VIEUX message sans `md` est parsé localement — le repli du contrat 4.3', () => {
    const arbre = arbreDuMessage(null, '**gras** et _italique_');
    assert.ok(arbre !== null);
    assert.equal(arbre[0].type, 'PARAGRAPH');
    assert.equal(texteDe(arbre), 'gras et italique');
  });

  test('un `md` corrompu en base retombe sur le texte au lieu de planter', () => {
    assert.equal(texteDe(arbreDuMessage('{pas du json', 'secours')), 'secours');
    assert.equal(texteDe(arbreDuMessage('"pas un tableau"', 'secours')), 'secours');
    assert.equal(texteDe(arbreDuMessage('[]', 'secours')), 'secours');
  });

  test('un `md` de FORME corrompue (éléments empoisonnés) retombe aussi sur le texte', () => {
    // Un tableau ne suffit pas : `[null]` ou un nœud sans `type` passait la
    // garde et plantait le rendu — durablement, le `md` étant persisté.
    assert.equal(texteDe(arbreDuMessage('[null]', 'secours')), 'secours');
    assert.equal(texteDe(arbreDuMessage('[{"value":[]}]', 'secours')), 'secours');
    assert.equal(texteDe(arbreDuMessage('[42]', 'secours')), 'secours');
  });

  test('ni `md` ni texte : null, pas une exception', () => {
    assert.equal(arbreDuMessage(null, null), null);
    assert.equal(arbreDuMessage(null, '   '), null);
  });
});

describe('texteDe', () => {
  test('aplatit les nœuds imbriqués', () => {
    const arbre = arbreDuMessage(null, '**gras _et italique_** `code`');
    assert.equal(texteDe(arbre), 'gras et italique code');
  });

  test('un code court connu rend son caractère', () => {
    const arbre = arbreDuMessage(null, ':smile: bonjour');
    assert.equal(texteDe(arbre), '😄 bonjour');
  });

  test('un code court inconnu reste littéral — un emoji personnalisé se lit encore', () => {
    const arbre = arbreDuMessage(null, 'bravo :shipit: !');
    assert.equal(texteDe(arbre), 'bravo :shipit: !');
  });

  test('un nœud inconnu rend une chaîne vide, pas un plantage', () => {
    assert.equal(texteDe({ type: 'FUTUR_TYPE' }), '');
    assert.equal(texteDe(42), '');
  });

  test('un TIMESTAMP rend son `fallback`, pas une chaîne vide', () => {
    // `<t:…:F>` produit un nœud dont `value` est un objet opaque ; le parseur
    // fournit `fallback` exactement pour l'affichage de secours.
    const arbre = arbreDuMessage(null, 'rdv <t:1720000000:F> ok');
    assert.match(texteDe(arbre), /rdv <t:1720000000:F> ok/);
  });

  test('un emoji unicode rend son caractère', () => {
    assert.equal(texteDe({ type: 'EMOJI', unicode: '🙂' }), '🙂');
  });
});

describe('unicodeDEmoji', () => {
  test('résout les deux formes que le serveur envoie', () => {
    assert.equal(unicodeDEmoji({ type: 'EMOJI', unicode: '🙂' }), '🙂');
    assert.equal(
      unicodeDEmoji({ type: 'EMOJI', value: { type: 'PLAIN_TEXT', value: 'tada' }, shortCode: 'tada' }),
      '🎉',
    );
  });

  test('un BIG_EMOJI peut n’en contenir aucun — le parseur ne valide pas', () => {
    // La preuve, prise sur le serveur 8.5 : `:pas_un_emoji:` seul sur sa ligne
    // ressort en BIG_EMOJI. Sans ce `null`, l'écran l'afficherait en 36 px.
    const arbre = arbreDuMessage(null, ':pas_un_emoji:');
    assert.ok(arbre !== null);
    assert.equal(arbre[0].type, 'BIG_EMOJI');
    const noeuds = (arbre[0] as { value: unknown[] }).value;
    assert.deepEqual(noeuds.map(unicodeDEmoji), [null]);
    assert.equal(texteDe(arbre), ':pas_un_emoji:');
  });

  test('ce qui n’est pas un nœud EMOJI vaut `null`', () => {
    assert.equal(unicodeDEmoji({ type: 'PLAIN_TEXT', value: 'smile' }), null);
    assert.equal(unicodeDEmoji(null), null);
    assert.equal(unicodeDEmoji('smile'), null);
  });
});
