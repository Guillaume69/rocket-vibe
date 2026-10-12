import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileKey, filePath, messageOfKey, photoUri, photoVersion, setWhatsAppCache } from './whatsappFiles.ts';

test('a message id survives the file path segment, which keeps to [A-Za-z0-9_-]', () => {
  for (const id of ['120363012345678901@g.us:3EB0ABCDEF0123456789', 'alice@s.whatsapp.net:x', 'é@lid:1', 'ab', 'abc', 'abcd']) {
    const key = fileKey(id);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
    assert.equal(messageOfKey(key), id);
  }
  assert.equal(filePath('a@b:c'), `/api/v1/files/${fileKey('a@b:c')}`);
  assert.equal(messageOfKey('not/valid'), null);
});

test('a photo is a file per JID and version; removed or unknown has none', () => {
  setWhatsAppCache('file:///cache/');
  const base = 'whatsapp://0123456789abcdef01234567';
  const version = photoVersion('/9j/4AAQ');
  assert.notEqual(version, photoVersion('/9j/4AAR'));
  assert.equal(photoUri(base, 'alice@s.whatsapp.net', version),
    `file:///cache/whatsapp/0123456789abcdef01234567/photos/alice_s_whatsapp_net-${version}.jpg`);
  assert.equal(photoVersion(''), 'none');
  assert.equal(photoUri(base, 'alice@s.whatsapp.net', 'none'), null);
  assert.equal(photoUri(base, 'alice@s.whatsapp.net', null), null);
  assert.equal(photoUri('https://chat.example.org', 'alice', version), null);
  setWhatsAppCache(null);
});
