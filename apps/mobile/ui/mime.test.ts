import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatCourt } from './mime.ts';

describe('formatCourt', () => {
  test('l’extension du nom prime', () => {
    assert.equal(formatCourt('photo.png', 'image/png'), 'PNG');
    assert.equal(formatCourt('IMG_0001.jpg', 'image/jpeg'), 'JPG');
    assert.equal(formatCourt('vocal-1.m4a', 'audio/mp4'), 'M4A');
  });

  test('sans extension exploitable, le sous-type MIME nettoyé', () => {
    assert.equal(formatCourt('scan', 'application/pdf'), 'PDF');
    assert.equal(formatCourt('archive.tar.gzipped-long', 'application/x-7z-compressed'), '7Z-COMPRESSED');
    assert.equal(formatCourt('doc', 'application/vnd.oasis.opendocument.text'), 'TEXT');
    assert.equal(formatCourt('carte', 'image/svg+xml'), 'SVG');
  });

  test('rien à dire : null', () => {
    assert.equal(formatCourt('blob', 'application/octet-stream'), null);
    assert.equal(formatCourt('blob', ''), null);
    assert.equal(formatCourt('.env', ''), null);
  });
});
