import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { shortFormat } from './mime.ts';

describe('shortFormat', () => {
  test("the name's extension wins", () => {
    assert.equal(shortFormat('photo.png', 'image/png'), 'PNG');
    assert.equal(shortFormat('IMG_0001.jpg', 'image/jpeg'), 'JPG');
    assert.equal(shortFormat('vocal-1.m4a', 'audio/mp4'), 'M4A');
  });

  test('without a usable extension, the cleaned MIME subtype', () => {
    assert.equal(shortFormat('scan', 'application/pdf'), 'PDF');
    assert.equal(shortFormat('archive.tar.gzipped-long', 'application/x-7z-compressed'), '7Z-COMPRESSED');
    assert.equal(shortFormat('doc', 'application/vnd.oasis.opendocument.text'), 'TEXT');
    assert.equal(shortFormat('map', 'image/svg+xml'), 'SVG');
  });

  test('nothing to say: null', () => {
    assert.equal(shortFormat('blob', 'application/octet-stream'), null);
    assert.equal(shortFormat('blob', ''), null);
    assert.equal(shortFormat('.env', ''), null);
  });
});
