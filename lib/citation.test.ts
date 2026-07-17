import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parse } from '@rocket.chat/message-parser';

import {
  citer,
  estJointeCitation,
  jointeCitationLocale,
  permalienMessage,
  premiereImageDesJointes,
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

describe('jointeCitationLocale', () => {
  test('reprend les pièces du message cité — son image s’affiche dans le bloc', () => {
    const image = { title: 'chat.jpg', image_url: '/file-upload/x/chat.jpg' };
    const jointes = JSON.parse(
      jointeCitationLocale({
        permalien: 'https://s/channel/g?msg=a',
        auteur: 'bob',
        texte: 'regarde',
        piecesJointes: JSON.stringify([image]),
      }),
    ) as { message_link: string; author_name?: string; text: string; attachments: unknown[] }[];
    assert.equal(jointes.length, 1);
    assert.equal(jointes[0]!.message_link, 'https://s/channel/g?msg=a');
    assert.equal(jointes[0]!.author_name, 'bob');
    assert.deepEqual(jointes[0]!.attachments, [image]);
  });

  test('citer une citation : le niveau 2 reste, SES citations (niveau 3) tombent, ses fichiers restent', () => {
    // Le message cité est lui-même une réponse : sa citation porte un fichier
    // ET une citation plus profonde — la même taille que le serveur (limite 2).
    const citationDuCite = {
      message_link: 'https://s/channel/g?msg=racine',
      author_name: 'alice',
      text: 'le début',
      attachments: [
        { title: 'piece.png', image_url: '/file-upload/y/piece.png' },
        { message_link: 'https://s/channel/g?msg=plus-vieux', text: 'trop profond' },
      ],
    };
    const jointes = JSON.parse(
      jointeCitationLocale({
        permalien: 'https://s/channel/g?msg=b',
        auteur: 'bob',
        texte: 'je cite une citation',
        piecesJointes: JSON.stringify([citationDuCite]),
      }),
    ) as { attachments: { message_link?: string; attachments?: unknown[] }[] }[];
    const niveau2 = jointes[0]!.attachments[0]!;
    assert.equal(niveau2.message_link, 'https://s/channel/g?msg=racine');
    assert.deepEqual(niveau2.attachments, [{ title: 'piece.png', image_url: '/file-upload/y/piece.png' }]);
  });

  test('sans pièces ni auteur : la citation minimale', () => {
    const jointes = JSON.parse(
      jointeCitationLocale({ permalien: 'https://s/direct/d?msg=c', auteur: null, texte: null, piecesJointes: null }),
    ) as Record<string, unknown>[];
    assert.deepEqual(jointes, [{ message_link: 'https://s/direct/d?msg=c', text: '', attachments: [] }]);
  });
});

describe('premiereImageDesJointes', () => {
  test('trouve la première image, en ignorant les citations imbriquées', () => {
    const jointes = JSON.stringify([
      { message_link: 'https://s/c?msg=a', attachments: [{ image_url: '/file-upload/cite.png' }] },
      { title: 'doc.pdf', title_link: '/file-upload/doc.pdf' },
      { title: 'photo.jpg', image_url: '/file-upload/photo.jpg' },
    ]);
    assert.equal(premiereImageDesJointes(jointes), '/file-upload/photo.jpg');
    assert.equal(premiereImageDesJointes(null), null);
    assert.equal(premiereImageDesJointes('pas du json'), null);
  });
});

describe('estJointeCitation', () => {
  test('`message_link` fait la citation — le critère du serveur', () => {
    assert.ok(estJointeCitation({ message_link: 'https://s/c?msg=a' }));
    assert.ok(!estJointeCitation({ image_url: '/f.png' }));
    assert.ok(!estJointeCitation(null));
  });
});
