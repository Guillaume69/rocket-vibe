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
  quoteText,
} from './quote.ts';
import { textOf } from './markdown.ts';

test('native quote cards preserve literal RC-like source prefixes while official quotes still strip them',()=>{
  const text='[ ](https://example.test/channel/general?msg=source) mots';
  assert.equal(quoteText({text,native_reference:{room_id:'origin',message_id:'source',revision:'1'}}),text);
  assert.equal(quoteText({text}),'mots');
  assert.equal(quoteText({text,native_reference:null}),'mots');
});

describe('messagePermalink', () => {
  test('canonical path by room type', () => {
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'c', name: 'general', rid: 'GENERAL', msgId: 'm1' }),
      'https://s/channel/general?msg=m1',
    );
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'p', name: 'private', rid: 'r2', msgId: 'm2' }),
      'https://s/group/private?msg=m2',
    );
    // A DM has no `name`: target it by rid, like the official clients.
    assert.equal(
      messagePermalink({ baseUrl: 'https://s', siteUrl: null, type: 'd', name: null, rid: 'aXbY', msgId: 'm3' }),
      'https://s/direct/aXbY?msg=m3',
    );
  });

  test('trailing slash removed, name encoded', () => {
    assert.equal(
      messagePermalink({ baseUrl: 'https://s/', siteUrl: null, type: 'c', name: 'été 2026', rid: 'r', msgId: 'm' }),
      'https://s/channel/%C3%A9t%C3%A9%202026?msg=m',
    );
  });

  test('Site_Url WINS over baseUrl, the only URL the server recognizes', () => {
    // The emulator bench case: the server is reached via 10.0.2.2, but its
    // `Site_Url` says localhost. The BeforeSaveJumpToMessage hook only
    // recognizes the quote if the link starts with Site_Url.
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

describe('quote', () => {
  test('invisible permalink first, reply after', () => {
    assert.equal(quote('https://s/channel/g?msg=m', 'yes!'), '[ ](https://s/channel/g?msg=m) yes!');
    assert.equal(quote('https://s/channel/g?msg=m', ''), '[ ](https://s/channel/g?msg=m)');
  });
});

describe('stripQuotePrefix', () => {
  test('strips the leading permalink, chains included (quote of a quote)', () => {
    assert.equal(stripQuotePrefix('[ ](https://s/channel/g?msg=a) hey'), 'hey');
    assert.equal(
      stripQuotePrefix('[ ](https://s/channel/g?msg=a) [ ](https://s/direct/d?msg=b) the gist'),
      'the gist',
    );
  });

  test('leaves ordinary text alone, and a link that is not leading', () => {
    assert.equal(stripQuotePrefix('a [link](https://x) normal'), 'a [link](https://x) normal');
    assert.equal(stripQuotePrefix('before [ ](https://s/c?msg=a)'), 'before [ ](https://s/c?msg=a)');
  });
});

describe('withoutQuoteLinks', () => {
  test('strips the permalink LINK node and the syntax space after it', () => {
    const tree = withoutQuoteLinks(parse('[ ](https://s/channel/g?msg=abc) hi'));
    assert.equal(textOf(tree), 'hi');
  });

  test('a message that is ONLY the quote becomes an empty tree', () => {
    assert.deepEqual(withoutQuoteLinks(parse('[ ](https://s/direct/x?msg=abc)')), []);
  });

  test('returns the SAME reference when there is nothing to strip', () => {
    const tree = parse('an **ordinary** message');
    assert.equal(withoutQuoteLinks(tree), tree);
  });

  test('spares a link with a real label, even to a `?msg=` (same reference)', () => {
    const raw = parse('[see this message](https://s/channel/g?msg=abc)');
    assert.equal(withoutQuoteLinks(raw), raw);
  });
});

describe('localQuoteAttachment', () => {
  test('keeps the quoted message’s attachments: its image shows in the block', () => {
    const image = { title: 'chat.jpg', image_url: '/file-upload/x/chat.jpg' };
    const attachments = JSON.parse(
      localQuoteAttachment({
        permalink: 'https://s/channel/g?msg=a',
        author: 'bob',
        text: 'look',
        attachments: JSON.stringify([image]),
      }),
    ) as { message_link: string; author_name?: string; text: string; attachments: unknown[] }[];
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.message_link, 'https://s/channel/g?msg=a');
    assert.equal(attachments[0]!.author_name, 'bob');
    assert.deepEqual(attachments[0]!.attachments, [image]);
  });

  test('quoting a quote: level 2 stays, ITS quotes (level 3) drop, its files stay', () => {
    // The quoted message is itself a reply: its quote carries a file AND a
    // deeper quote. Same chain length as the server (limit 2).
    const quoteOfQuoted = {
      message_link: 'https://s/channel/g?msg=root',
      author_name: 'alice',
      text: 'the start',
      attachments: [
        { title: 'piece.png', image_url: '/file-upload/y/piece.png' },
        { message_link: 'https://s/channel/g?msg=older', text: 'too deep' },
      ],
    };
    const attachments = JSON.parse(
      localQuoteAttachment({
        permalink: 'https://s/channel/g?msg=b',
        author: 'bob',
        text: 'I quote a quote',
        attachments: JSON.stringify([quoteOfQuoted]),
      }),
    ) as { attachments: { message_link?: string; attachments?: unknown[] }[] }[];
    const level2 = attachments[0]!.attachments[0]!;
    assert.equal(level2.message_link, 'https://s/channel/g?msg=root');
    assert.deepEqual(level2.attachments, [{ title: 'piece.png', image_url: '/file-upload/y/piece.png' }]);
  });

  test('no attachments and no author: the minimal quote', () => {
    const attachments = JSON.parse(
      localQuoteAttachment({ permalink: 'https://s/direct/d?msg=c', author: null, text: null, attachments: null }),
    ) as Record<string, unknown>[];
    assert.deepEqual(attachments, [{ message_link: 'https://s/direct/d?msg=c', text: '', attachments: [] }]);
  });
});

describe('firstAttachmentImage', () => {
  test('finds the first image, ignoring nested quotes', () => {
    const attachments = JSON.stringify([
      { message_link: 'https://s/c?msg=a', attachments: [{ image_url: '/file-upload/cite.png' }] },
      { title: 'doc.pdf', title_link: '/file-upload/doc.pdf' },
      { title: 'photo.jpg', image_url: '/file-upload/photo.jpg' },
    ]);
    assert.equal(firstAttachmentImage(attachments), '/file-upload/photo.jpg');
    assert.equal(firstAttachmentImage(null), null);
    assert.equal(firstAttachmentImage('not json'), null);
  });
});

describe('isQuoteAttachment', () => {
  test('`message_link` makes the quote: the server criterion', () => {
    assert.ok(isQuoteAttachment({ message_link: 'https://s/c?msg=a' }));
    assert.ok(!isQuoteAttachment({ image_url: '/f.png' }));
    assert.ok(!isQuoteAttachment(null));
  });
});
