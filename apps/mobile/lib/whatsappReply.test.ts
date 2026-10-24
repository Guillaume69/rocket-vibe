import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quote } from './quote.ts';
import { splitReply, whatsappState } from '@rocket-vibe/provider-whatsapp';

test('a reply from the composer gives the quoted message id back, plain text stays plain', () => {
  const permalink = `whatsapp://0123456789abcdef01234567/direct/${encodeURIComponent('a@s.whatsapp.net')}?msg=${encodeURIComponent('a@s.whatsapp.net:3EB0')}`;
  assert.deepEqual(splitReply(quote(permalink, 'Oui !')), { reply: 'a@s.whatsapp.net:3EB0', text: 'Oui !' });
  assert.deepEqual(splitReply(quote(permalink, '')), { reply: 'a@s.whatsapp.net:3EB0', text: '' });
  assert.deepEqual(splitReply('[ ](https://example.org) hello'), { reply: null, text: '[ ](https://example.org) hello' });
  assert.deepEqual(splitReply('just text'), { reply: null, text: 'just text' });
  assert.equal(whatsappState('whatsapp://0123456789abcdef01234567'), '0123456789abcdef01234567');
  assert.equal(whatsappState('https://chat.example.org'), null);
});
