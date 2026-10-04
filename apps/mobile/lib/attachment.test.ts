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

const URL_PROTEGEE =
  'https://chat.barrut.me/file-upload/BsN3iJPmA9pdCTNq7/rapport.pdf?rc_uid=uid-alice&rc_token=jeton-alice';

type Journal = {
  folders: string[];
  downloaded: [string, string][];
  shared: [string, string | null][];
};

/** Enregistre ce que chaque capacité native a reçu. */
function banc(): {
  log: Journal;
  natives: {
    createFolder: CreateFolder;
    download: DownloadFile;
    share: ShareFile;
  };
} {
  const journal: Journal = { folders: [], downloaded: [], shared: [] };
  return {
    log: journal,
    natives: {
      createFolder: async (chemin) => {
        journal.folders.push(chemin);
      },
      download: async (url, destination) => {
        journal.downloaded.push([url, destination]);
      },
      share: async (fichier, type) => {
        journal.shared.push([fichier, type]);
      },
    },
  };
}

describe('nomDeFichierSur', () => {
  test('garde un nom ordinaire tel quel, accents compris', () => {
    assert.equal(safeFileName('Résumé du trimestre.pdf'), 'Résumé du trimestre.pdf');
  });

  test('une remontée de dossier ne laisse que le dernier segment', () => {
    assert.equal(safeFileName('../../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('..\\..\\windows\\system32\\x.dll'), 'x.dll');
    assert.equal(safeFileName('/etc/shadow'), 'shadow');
  });

  test('un nom qui ne serait QUE des points ne peut pas désigner un dossier', () => {
    assert.equal(safeFileName('..'), 'fichier');
    assert.equal(safeFileName('.'), 'fichier');
    assert.equal(safeFileName('...'), 'fichier');
  });

  test('un fichier caché redevient visible', () => {
    assert.equal(safeFileName('.bashrc'), 'bashrc');
  });

  test('les caractères de contrôle et les séparateurs sont neutralisés', () => {
    // Un NUL littéral dans la source serait invisible à la relecture.
    assert.equal(safeFileName('a' + String.fromCharCode(0) + 'b.pdf'), 'a_b.pdf');
    assert.equal(safeFileName('a\nb.pdf'), 'a_b.pdf');
    assert.equal(safeFileName('C:x.pdf'), 'C_x.pdf');
    assert.equal(safeFileName('a*b?c.pdf'), 'a_b_c.pdf');
  });

  test('vide, absent ou blanc : un repli, jamais une chaîne vide', () => {
    assert.equal(safeFileName(''), 'fichier');
    assert.equal(safeFileName(null), 'fichier');
    assert.equal(safeFileName(undefined), 'fichier');
    assert.equal(safeFileName('   '), 'fichier');
  });

  test('un nom démesuré est plafonné, extension conservée', () => {
    const nom = safeFileName('a'.repeat(400) + '.pdf');
    assert.equal(nom.length, 120);
    assert.ok(nom.endsWith('.pdf'), 'c’est l’extension qui choisit l’application');
  });

  test('un plafonnement sans extension plausible ne fabrique pas de suffixe', () => {
    const nom = safeFileName('b'.repeat(200));
    assert.equal(nom.length, 120);
    assert.ok(!nom.includes('.'));
  });
});

describe('cleDeFichier', () => {
  test('l’identifiant Rocket.Chat sert de sous-dossier', () => {
    assert.equal(fileKey(URL_PROTEGEE), 'BsN3iJPmA9pdCTNq7');
    assert.equal(fileKey('/file-upload/abc123/photo.jpg'), 'abc123');
  });

  test('deux fichiers homonymes ne partagent pas de dossier', () => {
    assert.notEqual(
      fileKey('/file-upload/aaa/facture.pdf'),
      fileKey('/file-upload/bbb/facture.pdf'),
    );
  });

  test('une URL sans identifiant retombe sur un repli', () => {
    assert.equal(fileKey('/x.pdf'), 'divers');
    assert.equal(fileKey(''), 'divers');
  });

  test('la clé est assainie — elle devient un nom de dossier', () => {
    assert.equal(fileKey('/file-upload/..%2F..%2Fetc/x.pdf'), '2F2Fetc');
    assert.equal(fileKey('/file-upload/../x.pdf'), 'divers');
  });
});

describe('ouvrirFichierJoint', () => {
  test('le jeton va au téléchargement, JAMAIS au partage', async () => {
    const b = banc();
    await openAttachment({
      url: URL_PROTEGEE,
      title: 'rapport.pdf',
      type: 'application/pdf',
      folder: 'file:///cache/',
      ...b.natives,
    });

    assert.equal(b.log.downloaded.length, 1);
    assert.equal(b.log.downloaded[0]![0], URL_PROTEGEE, 'la requête reste dans le processus');

    assert.equal(b.log.shared.length, 1);
    const [partage, type] = b.log.shared[0]!;
    assert.ok(!partage.includes('rc_token'), 'aucun jeton dans ce qui sort');
    assert.ok(!partage.includes('rc_uid'));
    assert.ok(partage.startsWith('file:///cache/'), 'c’est un fichier local qui est partagé');
    assert.equal(type, 'application/pdf');
  });

  test('le fichier atterrit dans un sous-dossier par identifiant', async () => {
    const b = banc();
    const destination = await openAttachment({
      url: URL_PROTEGEE,
      title: 'rapport.pdf',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/rapport.pdf');
    assert.deepEqual(b.log.folders, ['file:///cache/jointes/BsN3iJPmA9pdCTNq7/']);
  });

  test('un dossier de cache sans barre finale ne colle pas les segments', async () => {
    const b = banc();
    const destination = await openAttachment({
      url: '/file-upload/id1/x.pdf',
      title: 'x.pdf',
      type: null,
      folder: 'file:///cache',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/x.pdf');
  });

  test('un titre forgé ne peut pas écrire hors du dossier', async () => {
    const b = banc();
    const destination = await openAttachment({
      url: URL_PROTEGEE,
      title: '../../../../data/data/com.rocketvibe.app/files/SQLite/base.db',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/base.db');
    assert.ok(!destination.includes('..'));
  });

  test('sans titre, le nom vient de l’URL — décodé, et sans la query', async () => {
    const b = banc();
    const destination = await openAttachment({
      url: 'https://h/file-upload/id1/mon%20rapport.pdf?rc_uid=u&rc_token=t',
      title: null,
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/mon rapport.pdf');
  });

  test('un titre blanc bascule sur le nom de l’URL', async () => {
    const b = banc();
    const destination = await openAttachment({
      url: 'https://h/file-upload/id1/vrai-nom.pdf',
      title: '   ',
      type: null,
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/vrai-nom.pdf');
  });

  test('un type vide est passé en null, pas en chaîne vide', async () => {
    const b = banc();
    await openAttachment({
      url: URL_PROTEGEE,
      title: 'x.pdf',
      type: '',
      folder: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(b.log.shared[0]![1], null);
  });

  test('un téléchargement en échec ne partage rien', async () => {
    const b = banc();
    await assert.rejects(
      openAttachment({
        url: URL_PROTEGEE,
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
    assert.equal(b.log.shared.length, 0, 'rien ne sort quand rien n’est arrivé');
  });

  test('l’ordre est dossier → téléchargement → partage', async () => {
    const ordre: string[] = [];
    await openAttachment({
      url: URL_PROTEGEE,
      title: 'x.pdf',
      type: null,
      folder: 'file:///cache/',
      createFolder: async () => {
        ordre.push('dossier');
      },
      download: async () => {
        ordre.push('telecharge');
      },
      share: async () => {
        ordre.push('partage');
      },
    });
    assert.deepEqual(ordre, ['dossier', 'telecharge', 'partage']);
  });
});

describe('jointeAPartager', () => {
  test('image : l’ORIGINAL (`title_link`), pas la vignette, avec son MIME', () => {
    const jointes = JSON.stringify([
      {
        title: 'photo.jpg',
        title_link: '/file-upload/orig/photo.jpg',
        image_url: '/file-upload/vignette/photo.jpg',
        image_type: 'image/jpeg',
      },
    ]);
    assert.deepEqual(attachmentToShare(jointes), {
      path: '/file-upload/orig/photo.jpg',
      title: 'photo.jpg',
      type: 'image/jpeg',
      size: null,
      encryption: null,
    });
  });

  test('vidéo sans `title_link` : repli sur `video_url`', () => {
    const jointes = JSON.stringify([
      { video_url: '/file-upload/v1/clip.mp4', video_type: 'video/mp4', video_size: 5_000_000 },
    ]);
    assert.deepEqual(attachmentToShare(jointes), {
      path: '/file-upload/v1/clip.mp4',
      title: null,
      type: 'video/mp4',
      size: 5_000_000,
      encryption: null,
    });
  });

  test('fichier d’un salon chiffré : sa clé suit, pour le rendre en clair', () => {
    const jointes = JSON.stringify([
      {
        title: 'rapport.pdf',
        title_link: '/file-upload/f1/5f2b.bin',
        encryption: { key: { kty: 'oct', k: 'Y2xl' }, iv: 'aXY=' },
        hashes: { sha256: 'abc' },
      },
    ]);
    assert.deepEqual(attachmentToShare(jointes)?.encryption, { key: { k: 'Y2xl' }, iv: 'aXY=', sha256: 'abc' });
  });

  test('une citation n’est pas un fichier du message', () => {
    const citation = {
      message_link: 'https://chat.example/channel/general?msg=abc',
      image_url: '/file-upload/x/cite.jpg',
    };
    assert.equal(attachmentToShare(JSON.stringify([citation])), null);
    const apres = JSON.stringify([citation, { title_link: '/file-upload/d1/doc.pdf', title: 'doc.pdf' }]);
    assert.equal(attachmentToShare(apres)?.path, '/file-upload/d1/doc.pdf');
  });

  test('rien d’exploitable : null', () => {
    assert.equal(attachmentToShare(null), null);
    assert.equal(attachmentToShare('pas du json'), null);
    assert.equal(attachmentToShare('{}'), null);
    assert.equal(attachmentToShare(JSON.stringify([{ text: 'embed' }])), null);
  });
});

describe('avecExtension', () => {
  test('garde un nom qui a déjà son extension', () => {
    assert.equal(withExtension('photo.png', 'image/jpeg'), 'photo.png');
  });

  test('complète d’après le MIME, table puis sous-type', () => {
    assert.equal(withExtension('photo', 'image/jpeg'), 'photo.jpg');
    assert.equal(withExtension('clip', 'video/quicktime'), 'clip.mov');
    assert.equal(withExtension('son', 'audio/x-wav'), 'son');
    assert.equal(withExtension('doc', 'application/zip'), 'doc.zip');
  });

  test('sans MIME : inchangé', () => {
    assert.equal(withExtension('fichier', null), 'fichier');
  });
});

describe('versGalerie', () => {
  test('photo, vidéo, son : par le MIME ou par l’extension', () => {
    assert.equal(toGallery('x', 'image/png'), true);
    assert.equal(toGallery('x', 'video/mp4'), true);
    assert.equal(toGallery('IMG_1.JPG', null), true);
    assert.equal(toGallery('note.m4a', null), true);
  });

  test('le reste va dans un dossier', () => {
    assert.equal(toGallery('rapport.pdf', 'application/pdf'), false);
    assert.equal(toGallery('archive.zip', null), false);
    assert.equal(toGallery('sans-extension', null), false);
  });
});

describe('telechargerFichierJoint', () => {
  test('nom sans extension : complété d’après le MIME', async () => {
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

describe('fractionTelechargee', () => {
  test('la taille annoncée par la réponse d’abord', () => {
    assert.equal(downloadedFraction(50, 200, 1000), 0.25);
  });

  test('réponse sans taille (chunked) : le poids du message prend le relais', () => {
    assert.equal(downloadedFraction(250, -1, 1000), 0.25);
    assert.equal(downloadedFraction(250, 0, 1000), 0.25);
  });

  test('plafonnée à 1, et null quand on ne sait rien', () => {
    assert.equal(downloadedFraction(1500, -1, 1000), 1);
    assert.equal(downloadedFraction(10, -1, null), null);
  });
});

describe('nomATeleverser', () => {
  test('une copie de cache au nom aléatoire part sous le nom d’origine', () => {
    assert.equal(
      uploadName('file:///data/cache/DocumentPicker/5852b590-3933.pdf', 'Scan 2026-09-24.pdf'),
      'Scan 2026-09-24.pdf',
    );
  });

  test('le fichier porte déjà son nom : rien à copier', () => {
    assert.equal(uploadName('file:///data/cache/Scan%202026.pdf', 'Scan 2026.pdf'), null);
    assert.equal(uploadName('file:///data/cache/vocal-1.m4a', 'vocal-1.m4a'), null);
  });

  test('un nom hostile est assaini avant de devenir un chemin', () => {
    assert.equal(uploadName('file:///c/x.png', '../../evil.png'), 'evil.png');
  });
});
