import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parse } from '@rocket.chat/message-parser';

import {
  quote,
  isQuoteAttachment,
  localQuoteAttachment,
  messagePermalink,
  firstAttachmentImage,
  withoutQuoteLinks,
  stripQuotePrefix,
} from './quote.ts';
import { textOf } from './markdown.ts';

describe('permalienMessage', () => {
  test('chemin canonique selon le type du salon', () => {
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'c', name: 'general', rid: 'GENERAL', msgId: 'm1' }),
      'https://s/channel/general?msg=m1',
    );
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'p', name: 'prive', rid: 'r2', msgId: 'm2' }),
      'https://s/group/prive?msg=m2',
    );
    // Un DM n'a pas de `name` : on vise par rid, comme les clients officiels.
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'd', name: null, rid: 'aXbY', msgId: 'm3' }),
      'https://s/direct/aXbY?msg=m3',
    );
  });

  test('barre finale retirée, nom encodé', () => {
    assert.equal(
      messagePermalink({ baseUrl: 'https://s/', siteUrl: null, type: 'c', name: 'été 2026', rid: 'r', msgId: 'm' }),
      'https://s/channel/%C3%A9t%C3%A9%202026?msg=m',
    );
  });

  test('Site_Url GAGNE sur baseUrl — seule URL que le serveur reconnaît', () => {
    // Le cas du banc émulateur : on joint le serveur par 10.0.2.2, mais son
    // `Site_Url` dit localhost. Le hook BeforeSaveJumpToMessage ne reconnaît la
    // citation que si le lien commence par Site_Url.
    assert.equal(
      messagePermalink({
        baseUrl: 'http://10.0.2.2:3300',
        siteUrl: 'http://localhost:3300/',
        type: 'c',
        name: 'general',
        rid: 'GENERAL',
        msgId: 'm1',
      }),
      'http://localhost:3300/channel/general?msg=m1',
    );
  });
});

describe('citer', () => {
  test('permalien invisible devant, réponse derrière', () => {
    assert.equal(quote('https://s/channel/g?msg=m', 'oui !'), '[ ](https://s/channel/g?msg=m) oui !');
    assert.equal(quote('https://s/channel/g?msg=m', ''), '[ ](https://s/channel/g?msg=m)');
  });
});

describe('sansPrefixeCitation', () => {
  test('retire le permalien de tête, y compris en chaîne (citation de citation)', () => {
    assert.equal(stripQuotePrefix('[ ](https://s/channel/g?msg=a) coucou'), 'coucou');
    assert.equal(
      stripQuotePrefix('[ ](https://s/channel/g?msg=a) [ ](https://s/direct/d?msg=b) le fond'),
      'le fond',
    );
  });

  test('laisse un texte ordinaire, et un lien qui n’est pas en tête', () => {
    assert.equal(stripQuotePrefix('un [lien](https://x) normal'), 'un [lien](https://x) normal');
    assert.equal(stripQuotePrefix('avant [ ](https://s/c?msg=a)'), 'avant [ ](https://s/c?msg=a)');
  });
});

describe('sansLiensDeCitation', () => {
  test('retire le nœud LINK du permalien et l’espace de syntaxe qui le suit', () => {
    const tree = withoutQuoteLinks(parse('[ ](https://s/channel/g?msg=abc) salut'));
    assert.equal(textOf(tree), 'salut');
  });

  test('un message qui n’est QUE la citation devient un arbre vide', () => {
    assert.deepEqual(withoutQuoteLinks(parse('[ ](https://s/direct/x?msg=abc)')), []);
  });

  test('rend la MÊME référence quand il n’y a rien à retirer', () => {
    const tree = parse('un message **ordinaire**');
    assert.equal(withoutQuoteLinks(tree), tree);
  });

  test('épargne un lien à étiquette réelle, même vers un `?msg=` (même référence)', () => {
    const raw = parse('[voir ce message](https://s/channel/g?msg=abc)');
    assert.equal(withoutQuoteLinks(raw), raw);
  });
});

describe('jointeCitationLocale', () => {
  test('reprend les pièces du message cité — son image s’affiche dans le bloc', () => {
    const image = { title: 'chat.jpg', image_url: '/file-upload/x/chat.jpg' };
    const attachments = JSON.parse(
      localQuoteAttachment({
        permalink: 'https://s/channel/g?msg=a',
        author: 'bob',
        text: 'regarde',
        attachments: JSON.stringify([image]),
      }),
    ) as { message_link: string; author_name?: string; text: string; attachments: unknown[] }[];
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.message_link, 'https://s/channel/g?msg=a');
    assert.equal(attachments[0]!.author_name, 'bob');
    assert.deepEqual(attachments[0]!.attachments, [image]);
  });

  test('citer une citation : le niveau 2 reste, SES citations (niveau 3) tombent, ses fichiers restent', () => {
    // Le message cité est lui-même une réponse : sa citation porte un fichier
    // ET une citation plus profonde — la même taille que le serveur (limite 2).
    const quoteOfQuoted = {
      message_link: 'https://s/channel/g?msg=racine',
      author_name: 'alice',
      text: 'le début',
      attachments: [
        { title: 'piece.png', image_url: '/file-upload/y/piece.png' },
        { message_link: 'https://s/channel/g?msg=plus-vieux', text: 'trop profond' },
      ],
    };
    const attachments = JSON.parse(
      localQuoteAttachment({
        permalink: 'https://s/channel/g?msg=b',
        author: 'bob',
        text: 'je cite une citation',
        attachments: JSON.stringify([quoteOfQuoted]),
      }),
    ) as { attachments: { message_link?: string; attachments?: unknown[] }[] }[];
    const level2 = attachments[0]!.attachments[0]!;
    assert.equal(level2.message_link, 'https://s/channel/g?msg=racine');
    assert.deepEqual(level2.attachments, [{ title: 'piece.png', image_url: '/file-upload/y/piece.png' }]);
  });

  test('sans pièces ni auteur : la citation minimale', () => {
    const attachments = JSON.parse(
      localQuoteAttachment({ permalink: 'https://s/direct/d?msg=c', author: null, text: null, attachments: null }),
    ) as Record<string, unknown>[];
    assert.deepEqual(attachments, [{ message_link: 'https://s/direct/d?msg=c', text: '', attachments: [] }]);
  });
});

describe('premiereImageDesJointes', () => {
  test('trouve la première image, en ignorant les citations imbriquées', () => {
    const attachments = JSON.stringify([
      { message_link: 'https://s/c?msg=a', attachments: [{ image_url: '/file-upload/cite.png' }] },
      { title: 'doc.pdf', title_link: '/file-upload/doc.pdf' },
      { title: 'photo.jpg', image_url: '/file-upload/photo.jpg' },
    ]);
    assert.equal(firstAttachmentImage(attachments), '/file-upload/photo.jpg');
    assert.equal(firstAttachmentImage(null), null);
    assert.equal(firstAttachmentImage('pas du json'), null);
  });
});

describe('estJointeCitation', () => {
  test('`message_link` fait la citation — le critère du serveur', () => {
    assert.ok(isQuoteAttachment({ message_link: 'https://s/c?msg=a' }));
    assert.ok(!isQuoteAttachment({ image_url: '/f.png' }));
    assert.ok(!isQuoteAttachment(null));
  });
});
