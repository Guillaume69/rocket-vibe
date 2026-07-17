import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parse } from '@rocket.chat/message-parser';

import {
  citer,
  permalienMessage,
  sansLiensDeCitation,
  sansPrefixeCitation,
} from './citation.ts';
import { texteDe } from './markdown.ts';

describe('permalienMessage', () => {
  test('chemin canonique selon le type du salon', () => {
    assert.equal(
      permalienMessage({ baseUrl: 'https://s', type: 'c', nom: 'general', rid: 'GENERAL', msgId: 'm1' }),
      'https://s/channel/general?msg=m1',
    );
    assert.equal(
      permalienMessage({ baseUrl: 'https://s', type: 'p', nom: 'prive', rid: 'r2', msgId: 'm2' }),
      'https://s/group/prive?msg=m2',
    );
    // Un DM n'a pas de `name` : on vise par rid, comme les clients officiels.
    assert.equal(
      permalienMessage({ baseUrl: 'https://s', type: 'd', nom: null, rid: 'aXbY', msgId: 'm3' }),
      'https://s/direct/aXbY?msg=m3',
    );
  });

  test('barre finale de baseUrl retirée, nom encodé', () => {
    assert.equal(
      permalienMessage({ baseUrl: 'https://s/', type: 'c', nom: 'été 2026', rid: 'r', msgId: 'm' }),
      'https://s/channel/%C3%A9t%C3%A9%202026?msg=m',
    );
  });
});

describe('citer', () => {
  test('permalien invisible devant, réponse derrière', () => {
    assert.equal(citer('https://s/channel/g?msg=m', 'oui !'), '[ ](https://s/channel/g?msg=m) oui !');
    assert.equal(citer('https://s/channel/g?msg=m', ''), '[ ](https://s/channel/g?msg=m)');
  });
});

describe('sansPrefixeCitation', () => {
  test('retire le permalien de tête, y compris en chaîne (citation de citation)', () => {
    assert.equal(sansPrefixeCitation('[ ](https://s/channel/g?msg=a) coucou'), 'coucou');
    assert.equal(
      sansPrefixeCitation('[ ](https://s/channel/g?msg=a) [ ](https://s/direct/d?msg=b) le fond'),
      'le fond',
    );
  });

  test('laisse un texte ordinaire, et un lien qui n’est pas en tête', () => {
    assert.equal(sansPrefixeCitation('un [lien](https://x) normal'), 'un [lien](https://x) normal');
    assert.equal(sansPrefixeCitation('avant [ ](https://s/c?msg=a)'), 'avant [ ](https://s/c?msg=a)');
  });
});

describe('sansLiensDeCitation', () => {
  test('retire le nœud LINK du permalien et l’espace de syntaxe qui le suit', () => {
    const arbre = sansLiensDeCitation(parse('[ ](https://s/channel/g?msg=abc) salut'));
    assert.equal(texteDe(arbre), 'salut');
  });

  test('un message qui n’est QUE la citation devient un arbre vide', () => {
    assert.deepEqual(sansLiensDeCitation(parse('[ ](https://s/direct/x?msg=abc)')), []);
  });

  test('rend la MÊME référence quand il n’y a rien à retirer', () => {
    const arbre = parse('un message **ordinaire**');
    assert.equal(sansLiensDeCitation(arbre), arbre);
  });

  test('épargne un lien à étiquette réelle, même vers un `?msg=` (même référence)', () => {
    const brut = parse('[voir ce message](https://s/channel/g?msg=abc)');
    assert.equal(sansLiensDeCitation(brut), brut);
  });
});
