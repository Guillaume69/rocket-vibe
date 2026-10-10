import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fileIcon, shortFormat } from './mime.ts';

describe('fileIcon', () => {
  test('a family, else the attachment', () => {
    assert.equal(fileIcon('video/mp4'), 'video-x-generic');
    assert.equal(fileIcon('audio/ogg'), 'audio-x-generic');
    assert.equal(fileIcon('application/pdf'), 'x-office-document');
    assert.equal(fileIcon('text/plain'), 'text-x-generic');
    assert.equal(fileIcon('application/zip'), 'package-x-generic');
    assert.equal(fileIcon('application/x-7z-compressed'), 'package-x-generic');
    assert.equal(fileIcon('application/octet-stream'), 'mail-attachment');
  });
});

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
