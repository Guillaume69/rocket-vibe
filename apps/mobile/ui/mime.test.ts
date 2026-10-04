import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { shortFormat } from './mime.ts';

describe('formatCourt', () => {
  test('l’extension du nom prime', () => {
    assert.equal(shortFormat('photo.png', 'image/png'), 'PNG');
    assert.equal(shortFormat('IMG_0001.jpg', 'image/jpeg'), 'JPG');
    assert.equal(shortFormat('vocal-1.m4a', 'audio/mp4'), 'M4A');
  });

  test('sans extension exploitable, le sous-type MIME nettoyé', () => {
    assert.equal(shortFormat('scan', 'application/pdf'), 'PDF');
    assert.equal(shortFormat('archive.tar.gzipped-long', 'application/x-7z-compressed'), '7Z-COMPRESSED');
    assert.equal(shortFormat('doc', 'application/vnd.oasis.opendocument.text'), 'TEXT');
    assert.equal(shortFormat('carte', 'image/svg+xml'), 'SVG');
  });

  test('rien à dire : null', () => {
    assert.equal(shortFormat('blob', 'application/octet-stream'), null);
    assert.equal(shortFormat('blob', ''), null);
    assert.equal(shortFormat('.env', ''), null);
  });
});
