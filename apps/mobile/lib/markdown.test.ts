import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { textPreview, messageTree, textOf, unicodeDEmoji } from './markdown.ts';

describe('arbreDuMessage', () => {
  test('préfère le `md` du serveur quand il est présent', () => {
    const md = JSON.stringify([
      { type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: 'serveur' }] },
    ]);
    const tree = messageTree(md, 'texte ignoré');
    assert.equal(textOf(tree), 'serveur');
  });

  test('un VIEUX message sans `md` est parsé localement — le repli du contrat 4.3', () => {
    const tree = messageTree(null, '**gras** et _italique_');
    assert.ok(tree !== null);
    assert.equal(tree[0].type, 'PARAGRAPH');
    assert.equal(textOf(tree), 'gras et italique');
  });

  test('un `md` corrompu en base retombe sur le texte au lieu de planter', () => {
    assert.equal(textOf(messageTree('{pas du json', 'secours')), 'secours');
    assert.equal(textOf(messageTree('"pas un tableau"', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[]', 'secours')), 'secours');
  });

  test('un `md` de FORME corrompue (éléments empoisonnés) retombe aussi sur le texte', () => {
    // Un tableau ne suffit pas : `[null]` ou un nœud sans `type` passait la
    // garde et plantait le rendu — durablement, le `md` étant persisté.
    assert.equal(textOf(messageTree('[null]', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[{"value":[]}]', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[42]', 'secours')), 'secours');
  });

  test('ni `md` ni texte : null, pas une exception', () => {
    assert.equal(messageTree(null, null), null);
    assert.equal(messageTree(null, '   '), null);
  });
});

describe('texteDe', () => {
  test('aplatit les nœuds imbriqués', () => {
    const tree = messageTree(null, '**gras _et italique_** `code`');
    assert.equal(textOf(tree), 'gras et italique code');
  });

  test('un code court connu rend son caractère', () => {
    const tree = messageTree(null, ':smile: bonjour');
    assert.equal(textOf(tree), '😄 bonjour');
  });

  test('un code court inconnu reste littéral — un emoji personnalisé se lit encore', () => {
    const tree = messageTree(null, 'bravo :shipit: !');
    assert.equal(textOf(tree), 'bravo :shipit: !');
  });

  test('un nœud inconnu rend une chaîne vide, pas un plantage', () => {
    assert.equal(textOf({ type: 'FUTUR_TYPE' }), '');
    assert.equal(textOf(42), '');
  });

  test('un TIMESTAMP rend son `fallback`, pas une chaîne vide', () => {
    // `<t:…:F>` produit un nœud dont `value` est un objet opaque ; le parseur
    // fournit `fallback` exactement pour l'affichage de secours.
    const tree = messageTree(null, 'rdv <t:1720000000:F> ok');
    assert.match(textOf(tree), /rdv <t:1720000000:F> ok/);
  });

  test('un emoji unicode rend son caractère', () => {
    assert.equal(textOf({ type: 'EMOJI', unicode: '🙂' }), '🙂');
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
    const tree = messageTree(null, ':pas_un_emoji:');
    assert.ok(tree !== null);
    assert.equal(tree[0].type, 'BIG_EMOJI');
    const nodes = (tree[0] as { value: unknown[] }).value;
    assert.deepEqual(nodes.map(unicodeDEmoji), [null]);
    assert.equal(textOf(tree), ':pas_un_emoji:');
  });

  test('ce qui n’est pas un nœud EMOJI vaut `null`', () => {
    assert.equal(unicodeDEmoji({ type: 'PLAIN_TEXT', value: 'smile' }), null);
    assert.equal(unicodeDEmoji(null), null);
    assert.equal(unicodeDEmoji('smile'), null);
  });
});

describe('apercuTexte', () => {
  test('un aperçu se lit comme du texte, sans syntaxe markdown', () => {
    assert.equal(textPreview('```\nZOB\n```'), 'ZOB');
    assert.equal(textPreview('[t.gg](http://t.gg) *gras* ~barré~ `code`'), 't.gg gras barré code');
    assert.equal(textPreview('salut @bob #general\n\n- un\n- deux'), 'salut @bob #general • un • deux');
    assert.equal(textPreview(':kkk: :smile:'), ':kkk: 😄');
  });
});
