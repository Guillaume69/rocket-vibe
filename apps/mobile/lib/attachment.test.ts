import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  fileKey,
  withExtension,
  downloadedFraction,
  attachmentToShare,
  downloadAttachment,
  toGallery,
  uploadName,
  safeFileName,
  openAttachment,
  type CreateFolder,
  type ShareFile,
  type DownloadFile,
} from './attachment.ts';

const PROTECTED_URL =
  'https://chat.barrut.me/file-upload/BsN3iJPmA9pdCTNq7/rapport.pdf?rc_uid=uid-alice&rc_token=jeton-alice';

type Log = {
  folders: string[];
  downloaded: [string, string][];
  shared: [string, string | null][];
};

/** Records what each native capability received. */
function bench(): {
  log: Log;
  natives: {
    createFolder: CreateFolder;
    download: DownloadFile;
    share: ShareFile;
  };
} {
  const log: Log = { folders: [], downloaded: [], shared: [] };
  return {
    log,
    natives: {
      createFolder: async (path) => {
        log.folders.push(path);
      },
      download: async (url, destination) => {
        log.downloaded.push([url, destination]);
      },
      share: async (file, type) => {
        log.shared.push([file, type]);
      },
    },
  };
}

describe('safeFileName', () => {
  test('keeps an ordinary name as is, accents included', () => {
    assert.equal(safeFileName('Résumé du trimestre.pdf'), 'Résumé du trimestre.pdf');
  });

  test('directory traversal leaves only the last segment', () => {
    assert.equal(safeFileName('../../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('..\\..\\windows\\system32\\x.dll'), 'x.dll');
    assert.equal(safeFileName('/etc/shadow'), 'shadow');
  });

  test('a name made ONLY of dots cannot designate a folder', () => {
    assert.equal(safeFileName('..'), 'fichier');
    assert.equal(safeFileName('.'), 'fichier');
    assert.equal(safeFileName('...'), 'fichier');
  });

  test('a hidden file becomes visible again', () => {
    assert.equal(safeFileName('.bashrc'), 'bashrc');
  });

  test('control characters and separators are neutralised', () => {
    // A literal NUL in the source would be invisible on review.
    assert.equal(safeFileName('a' + String.fromCharCode(0) + 'b.pdf'), 'a_b.pdf');
    assert.equal(safeFileName('a\nb.pdf'), 'a_b.pdf');
    assert.equal(safeFileName('C:x.pdf'), 'C_x.pdf');
    assert.equal(safeFileName('a*b?c.pdf'), 'a_b_c.pdf');
  });

  test('empty, missing or blank: a fallback, never an empty string', () => {
    assert.equal(safeFileName(''), 'fichier');
    assert.equal(safeFileName(null), 'fichier');
    assert.equal(safeFileName(undefined), 'fichier');
    assert.equal(safeFileName('   '), 'fichier');
  });

  test('an oversized name is capped, extension kept', () => {
    const name = safeFileName('a'.repeat(400) + '.pdf');
    assert.equal(name.length, 120);
    assert.ok(name.endsWith('.pdf'), 'the extension picks the app');
  });

  test('capping without a plausible extension does not invent a suffix', () => {
    const name = safeFileName('b'.repeat(200));
    assert.equal(name.length, 120);
    assert.ok(!name.includes('.'));
  });
});

describe('fileKey', () => {
  test('the Rocket.Chat id is used as the subfolder', () => {
    assert.equal(fileKey(PROTECTED_URL), 'BsN3iJPmA9pdCTNq7');
    assert.equal(fileKey('/file-upload/abc123/photo.jpg'), 'abc123');
  });

  test('two files with the same name do not share a folder', () => {
    assert.notEqual(
      fileKey('/file-upload/aaa/facture.pdf'),
      fileKey('/file-upload/bbb/facture.pdf'),
    );
  });

  test('a URL without an id falls back', () => {
    assert.equal(fileKey('/x.pdf'), 'divers');
    assert.equal(fileKey(''), 'divers');
  });

  test('the key is sanitised: it becomes a folder name', () => {
    assert.equal(fileKey('/file-upload/..%2F..%2Fetc/x.pdf'), '2F2Fetc');
    assert.equal(fileKey('/file-upload/../x.pdf'), 'divers');
  });
});

describe('openAttachment', () => {
  test('the token goes to the download, NEVER to the share', async () => {
    const b = bench();
    await openAttachment({
      url: PROTECTED_URL,
      title: 'rapport.pdf',
      type: 'application/pdf',
      folder: 'file:///cache/',
      ...b.natives,
    });

    assert.equal(b.log.downloaded.length, 1);
    assert.equal(b.log.downloaded[0]![0], PROTECTED_URL, 'the request stays in the process');

    assert.equal(b.log.shared.length, 1);
    const [shared, type] = b.log.shared[0]!;
    assert.ok(!shared.includes('rc_token'), 'no token in what goes out');
    assert.ok(!shared.includes('rc_uid'));
    assert.ok(shared.startsWith('file:///cache/'), 'a local file is what gets shared');
    assert.equal(type, 'application/pdf');
  });

  test('the file lands in a per-id subfolder', async () => {
    const b = bench();
    const destination = await openAttachment({
      url: PROTECTED_URL,
      title: 'rapport.pdf',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/rapport.pdf');
    assert.deepEqual(b.log.folders, ['file:///cache/jointes/BsN3iJPmA9pdCTNq7/']);
  });

  test('a cache folder without a trailing slash does not glue the segments', async () => {
    const b = bench();
    const destination = await openAttachment({
      url: '/file-upload/id1/x.pdf',
      title: 'x.pdf',
      type: null,
      folder: 'file:///cache',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/x.pdf');
  });

  test('a forged title cannot write outside the folder', async () => {
    const b = bench();
    const destination = await openAttachment({
      url: PROTECTED_URL,
      title: '../../../../data/data/com.rocketvibe.app/files/SQLite/base.db',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/base.db');
    assert.ok(!destination.includes('..'));
  });

  test('without a title, the name comes from the URL, decoded and without the query', async () => {
    const b = bench();
    const destination = await openAttachment({
      url: 'https://h/file-upload/id1/mon%20rapport.pdf?rc_uid=u&rc_token=t',
      title: null,
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/mon rapport.pdf');
  });

  test('a blank title falls back to the URL name', async () => {
    const b = bench();
    const destination = await openAttachment({
      url: 'https://h/file-upload/id1/vrai-nom.pdf',
      title: '   ',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/vrai-nom.pdf');
  });

  test('an empty type is passed as null, not as an empty string', async () => {
    const b = bench();
    await openAttachment({
      url: PROTECTED_URL,
      title: 'x.pdf',
      type: '',
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(b.log.shared[0]![1], null);
  });

  test('a failed download shares nothing', async () => {
    const b = bench();
    await assert.rejects(
      openAttachment({
        url: PROTECTED_URL,
        title: 'x.pdf',
        type: null,
        folder: 'file:///cache/',
        createFolder: b.natives.createFolder,
        download: async () => {
          throw new Error('HTTP 403');
        },
        share: b.natives.share,
      }),
      /403/,
    );
    assert.equal(b.log.shared.length, 0, 'nothing goes out when nothing arrived');
  });

  test('the order is folder → download → share', async () => {
    const order: string[] = [];
    await openAttachment({
      url: PROTECTED_URL,
      title: 'x.pdf',
      type: null,
      folder: 'file:///cache/',
      createFolder: async () => {
        order.push('dossier');
      },
      download: async () => {
        order.push('telecharge');
      },
      share: async () => {
        order.push('partage');
      },
    });
    assert.deepEqual(order, ['dossier', 'telecharge', 'partage']);
  });
});

describe('attachmentToShare', () => {
  test('image: the ORIGINAL (`title_link`), not the thumbnail, with its MIME', () => {
    const attachments = JSON.stringify([
      {
        title: 'photo.jpg',
        title_link: '/file-upload/orig/photo.jpg',
        image_url: '/file-upload/vignette/photo.jpg',
        image_type: 'image/jpeg',
      },
    ]);
    assert.deepEqual(attachmentToShare(attachments), {
      path: '/file-upload/orig/photo.jpg',
      title: 'photo.jpg',
      type: 'image/jpeg',
      size: null,
      encryption: null,
    });
  });

  test('video without `title_link`: falls back to `video_url`', () => {
    const attachments = JSON.stringify([
      { video_url: '/file-upload/v1/clip.mp4', video_type: 'video/mp4', video_size: 5_000_000 },
    ]);
    assert.deepEqual(attachmentToShare(attachments), {
      path: '/file-upload/v1/clip.mp4',
      title: null,
      type: 'video/mp4',
      size: 5_000_000,
      encryption: null,
    });
  });

  test('file of an encrypted room: its key follows, to decrypt it', () => {
    const attachments = JSON.stringify([
      {
        title: 'rapport.pdf',
        title_link: '/file-upload/f1/5f2b.bin',
        encryption: { key: { kty: 'oct', k: 'Y2xl' }, iv: 'aXY=' },
        hashes: { sha256: 'abc' },
      },
    ]);
    assert.deepEqual(attachmentToShare(attachments)?.encryption, { key: { k: 'Y2xl' }, iv: 'aXY=', sha256: 'abc' });
  });

  test('a quote is not a file of the message', () => {
    const quote = {
      message_link: 'https://chat.example/channel/general?msg=abc',
      image_url: '/file-upload/x/cite.jpg',
    };
    assert.equal(attachmentToShare(JSON.stringify([quote])), null);
    const after = JSON.stringify([quote, { title_link: '/file-upload/d1/doc.pdf', title: 'doc.pdf' }]);
    assert.equal(attachmentToShare(after)?.path, '/file-upload/d1/doc.pdf');
  });

  test('nothing usable: null', () => {
    assert.equal(attachmentToShare(null), null);
    assert.equal(attachmentToShare('pas du json'), null);
    assert.equal(attachmentToShare('{}'), null);
    assert.equal(attachmentToShare(JSON.stringify([{ text: 'embed' }])), null);
  });
});

describe('withExtension', () => {
  test('keeps a name that already has its extension', () => {
    assert.equal(withExtension('photo.png', 'image/jpeg'), 'photo.png');
  });

  test('completes from the MIME, table then subtype', () => {
    assert.equal(withExtension('photo', 'image/jpeg'), 'photo.jpg');
    assert.equal(withExtension('clip', 'video/quicktime'), 'clip.mov');
    assert.equal(withExtension('son', 'audio/x-wav'), 'son');
    assert.equal(withExtension('doc', 'application/zip'), 'doc.zip');
  });

  test('without a MIME: unchanged', () => {
    assert.equal(withExtension('fichier', null), 'fichier');
  });
});

describe('toGallery', () => {
  test('photo, video, audio: by MIME or by extension', () => {
    assert.equal(toGallery('x', 'image/png'), true);
    assert.equal(toGallery('x', 'video/mp4'), true);
    assert.equal(toGallery('IMG_1.JPG', null), true);
    assert.equal(toGallery('note.m4a', null), true);
  });

  test('the rest goes to a folder', () => {
    assert.equal(toGallery('rapport.pdf', 'application/pdf'), false);
    assert.equal(toGallery('archive.zip', null), false);
    assert.equal(toGallery('sans-extension', null), false);
  });
});

describe('downloadAttachment', () => {
  test('name without an extension: completed from the MIME', async () => {
    const destination = await downloadAttachment({
      url: 'https://chat.example/file-upload/ab12/photo?rc_token=t',
      title: null,
      type: 'image/jpeg',
      folder: 'file:///cache',
      createFolder: async () => {},
      download: async () => {},
    });
    assert.equal(destination, 'file:///cache/jointes/ab12/photo.jpg');
  });
});

describe('downloadedFraction', () => {
  test('the size announced by the response first', () => {
    assert.equal(downloadedFraction(50, 200, 1000), 0.25);
  });

  test('response without a size (chunked): the message size takes over', () => {
    assert.equal(downloadedFraction(250, -1, 1000), 0.25);
    assert.equal(downloadedFraction(250, 0, 1000), 0.25);
  });

  test('capped at 1, and null when nothing is known', () => {
    assert.equal(downloadedFraction(1500, -1, 1000), 1);
    assert.equal(downloadedFraction(10, -1, null), null);
  });
});

describe('uploadName', () => {
  test('a randomly named cache copy leaves under the original name', () => {
    assert.equal(
      uploadName('file:///data/cache/DocumentPicker/5852b590-3933.pdf', 'Scan 2026-09-24.pdf'),
      'Scan 2026-09-24.pdf',
    );
  });

  test('the file already carries its name: nothing to copy', () => {
    assert.equal(uploadName('file:///data/cache/Scan%202026.pdf', 'Scan 2026.pdf'), null);
    assert.equal(uploadName('file:///data/cache/vocal-1.m4a', 'vocal-1.m4a'), null);
  });

  test('a hostile name is sanitised before becoming a path', () => {
    assert.equal(uploadName('file:///c/x.png', '../../evil.png'), 'evil.png');
  });
});
