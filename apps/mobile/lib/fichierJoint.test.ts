import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  cleDeFichier,
  avecExtension,
  fractionTelechargee,
  jointeAPartager,
  telechargerFichierJoint,
  versGalerie,
  nomDeFichierSur,
  ouvrirFichierJoint,
  type CreerDossier,
  type PartagerFichier,
  type TelechargerFichier,
} from './fichierJoint.ts';

const URL_PROTEGEE =
  'https://chat.barrut.me/file-upload/BsN3iJPmA9pdCTNq7/rapport.pdf?rc_uid=uid-alice&rc_token=jeton-alice';

type Journal = {
  dossiers: string[];
  telecharges: [string, string][];
  partages: [string, string | null][];
};

/** Enregistre ce que chaque capacité native a reçu. */
function banc(): {
  journal: Journal;
  natives: {
    creerDossier: CreerDossier;
    telecharger: TelechargerFichier;
    partager: PartagerFichier;
  };
} {
  const journal: Journal = { dossiers: [], telecharges: [], partages: [] };
  return {
    journal,
    natives: {
      creerDossier: async (chemin) => {
        journal.dossiers.push(chemin);
      },
      telecharger: async (url, destination) => {
        journal.telecharges.push([url, destination]);
      },
      partager: async (fichier, type) => {
        journal.partages.push([fichier, type]);
      },
    },
  };
}

describe('nomDeFichierSur', () => {
  test('garde un nom ordinaire tel quel, accents compris', () => {
    assert.equal(nomDeFichierSur('Résumé du trimestre.pdf'), 'Résumé du trimestre.pdf');
  });

  test('une remontée de dossier ne laisse que le dernier segment', () => {
    assert.equal(nomDeFichierSur('../../../etc/passwd'), 'passwd');
    assert.equal(nomDeFichierSur('..\\..\\windows\\system32\\x.dll'), 'x.dll');
    assert.equal(nomDeFichierSur('/etc/shadow'), 'shadow');
  });

  test('un nom qui ne serait QUE des points ne peut pas désigner un dossier', () => {
    assert.equal(nomDeFichierSur('..'), 'fichier');
    assert.equal(nomDeFichierSur('.'), 'fichier');
    assert.equal(nomDeFichierSur('...'), 'fichier');
  });

  test('un fichier caché redevient visible', () => {
    assert.equal(nomDeFichierSur('.bashrc'), 'bashrc');
  });

  test('les caractères de contrôle et les séparateurs sont neutralisés', () => {
    // Un NUL littéral dans la source serait invisible à la relecture.
    assert.equal(nomDeFichierSur('a' + String.fromCharCode(0) + 'b.pdf'), 'a_b.pdf');
    assert.equal(nomDeFichierSur('a\nb.pdf'), 'a_b.pdf');
    assert.equal(nomDeFichierSur('C:x.pdf'), 'C_x.pdf');
    assert.equal(nomDeFichierSur('a*b?c.pdf'), 'a_b_c.pdf');
  });

  test('vide, absent ou blanc : un repli, jamais une chaîne vide', () => {
    assert.equal(nomDeFichierSur(''), 'fichier');
    assert.equal(nomDeFichierSur(null), 'fichier');
    assert.equal(nomDeFichierSur(undefined), 'fichier');
    assert.equal(nomDeFichierSur('   '), 'fichier');
  });

  test('un nom démesuré est plafonné, extension conservée', () => {
    const nom = nomDeFichierSur('a'.repeat(400) + '.pdf');
    assert.equal(nom.length, 120);
    assert.ok(nom.endsWith('.pdf'), 'c’est l’extension qui choisit l’application');
  });

  test('un plafonnement sans extension plausible ne fabrique pas de suffixe', () => {
    const nom = nomDeFichierSur('b'.repeat(200));
    assert.equal(nom.length, 120);
    assert.ok(!nom.includes('.'));
  });
});

describe('cleDeFichier', () => {
  test('l’identifiant Rocket.Chat sert de sous-dossier', () => {
    assert.equal(cleDeFichier(URL_PROTEGEE), 'BsN3iJPmA9pdCTNq7');
    assert.equal(cleDeFichier('/file-upload/abc123/photo.jpg'), 'abc123');
  });

  test('deux fichiers homonymes ne partagent pas de dossier', () => {
    assert.notEqual(
      cleDeFichier('/file-upload/aaa/facture.pdf'),
      cleDeFichier('/file-upload/bbb/facture.pdf'),
    );
  });

  test('une URL sans identifiant retombe sur un repli', () => {
    assert.equal(cleDeFichier('/x.pdf'), 'divers');
    assert.equal(cleDeFichier(''), 'divers');
  });

  test('la clé est assainie — elle devient un nom de dossier', () => {
    assert.equal(cleDeFichier('/file-upload/..%2F..%2Fetc/x.pdf'), '2F2Fetc');
    assert.equal(cleDeFichier('/file-upload/../x.pdf'), 'divers');
  });
});

describe('ouvrirFichierJoint', () => {
  test('le jeton va au téléchargement, JAMAIS au partage', async () => {
    const b = banc();
    await ouvrirFichierJoint({
      url: URL_PROTEGEE,
      titre: 'rapport.pdf',
      type: 'application/pdf',
      dossier: 'file:///cache/',
      ...b.natives,
    });

    assert.equal(b.journal.telecharges.length, 1);
    assert.equal(b.journal.telecharges[0]![0], URL_PROTEGEE, 'la requête reste dans le processus');

    assert.equal(b.journal.partages.length, 1);
    const [partage, type] = b.journal.partages[0]!;
    assert.ok(!partage.includes('rc_token'), 'aucun jeton dans ce qui sort');
    assert.ok(!partage.includes('rc_uid'));
    assert.ok(partage.startsWith('file:///cache/'), 'c’est un fichier local qui est partagé');
    assert.equal(type, 'application/pdf');
  });

  test('le fichier atterrit dans un sous-dossier par identifiant', async () => {
    const b = banc();
    const destination = await ouvrirFichierJoint({
      url: URL_PROTEGEE,
      titre: 'rapport.pdf',
      type: null,
      dossier: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/rapport.pdf');
    assert.deepEqual(b.journal.dossiers, ['file:///cache/jointes/BsN3iJPmA9pdCTNq7/']);
  });

  test('un dossier de cache sans barre finale ne colle pas les segments', async () => {
    const b = banc();
    const destination = await ouvrirFichierJoint({
      url: '/file-upload/id1/x.pdf',
      titre: 'x.pdf',
      type: null,
      dossier: 'file:///cache',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/x.pdf');
  });

  test('un titre forgé ne peut pas écrire hors du dossier', async () => {
    const b = banc();
    const destination = await ouvrirFichierJoint({
      url: URL_PROTEGEE,
      titre: '../../../../data/data/com.rocketvibe.app/files/SQLite/base.db',
      type: null,
      dossier: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/BsN3iJPmA9pdCTNq7/base.db');
    assert.ok(!destination.includes('..'));
  });

  test('sans titre, le nom vient de l’URL — décodé, et sans la query', async () => {
    const b = banc();
    const destination = await ouvrirFichierJoint({
      url: 'https://h/file-upload/id1/mon%20rapport.pdf?rc_uid=u&rc_token=t',
      titre: null,
      type: null,
      dossier: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/mon rapport.pdf');
  });

  test('un titre blanc bascule sur le nom de l’URL', async () => {
    const b = banc();
    const destination = await ouvrirFichierJoint({
      url: 'https://h/file-upload/id1/vrai-nom.pdf',
      titre: '   ',
      type: null,
      dossier: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(destination, 'file:///cache/jointes/id1/vrai-nom.pdf');
  });

  test('un type vide est passé en null, pas en chaîne vide', async () => {
    const b = banc();
    await ouvrirFichierJoint({
      url: URL_PROTEGEE,
      titre: 'x.pdf',
      type: '',
      dossier: 'file:///cache/',
      ...b.natives,
    });
    assert.equal(b.journal.partages[0]![1], null);
  });

  test('un téléchargement en échec ne partage rien', async () => {
    const b = banc();
    await assert.rejects(
      ouvrirFichierJoint({
        url: URL_PROTEGEE,
        titre: 'x.pdf',
        type: null,
        dossier: 'file:///cache/',
        creerDossier: b.natives.creerDossier,
        telecharger: async () => {
          throw new Error('HTTP 403');
        },
        partager: b.natives.partager,
      }),
      /403/,
    );
    assert.equal(b.journal.partages.length, 0, 'rien ne sort quand rien n’est arrivé');
  });

  test('l’ordre est dossier → téléchargement → partage', async () => {
    const ordre: string[] = [];
    await ouvrirFichierJoint({
      url: URL_PROTEGEE,
      titre: 'x.pdf',
      type: null,
      dossier: 'file:///cache/',
      creerDossier: async () => {
        ordre.push('dossier');
      },
      telecharger: async () => {
        ordre.push('telecharge');
      },
      partager: async () => {
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
    assert.deepEqual(jointeAPartager(jointes), {
      chemin: '/file-upload/orig/photo.jpg',
      titre: 'photo.jpg',
      type: 'image/jpeg',
      taille: null,
    });
  });

  test('vidéo sans `title_link` : repli sur `video_url`', () => {
    const jointes = JSON.stringify([
      { video_url: '/file-upload/v1/clip.mp4', video_type: 'video/mp4', video_size: 5_000_000 },
    ]);
    assert.deepEqual(jointeAPartager(jointes), {
      chemin: '/file-upload/v1/clip.mp4',
      titre: null,
      type: 'video/mp4',
      taille: 5_000_000,
    });
  });

  test('une citation n’est pas un fichier du message', () => {
    const citation = {
      message_link: 'https://chat.example/channel/general?msg=abc',
      image_url: '/file-upload/x/cite.jpg',
    };
    assert.equal(jointeAPartager(JSON.stringify([citation])), null);
    const apres = JSON.stringify([citation, { title_link: '/file-upload/d1/doc.pdf', title: 'doc.pdf' }]);
    assert.equal(jointeAPartager(apres)?.chemin, '/file-upload/d1/doc.pdf');
  });

  test('rien d’exploitable : null', () => {
    assert.equal(jointeAPartager(null), null);
    assert.equal(jointeAPartager('pas du json'), null);
    assert.equal(jointeAPartager('{}'), null);
    assert.equal(jointeAPartager(JSON.stringify([{ text: 'embed' }])), null);
  });
});

describe('avecExtension', () => {
  test('garde un nom qui a déjà son extension', () => {
    assert.equal(avecExtension('photo.png', 'image/jpeg'), 'photo.png');
  });

  test('complète d’après le MIME, table puis sous-type', () => {
    assert.equal(avecExtension('photo', 'image/jpeg'), 'photo.jpg');
    assert.equal(avecExtension('clip', 'video/quicktime'), 'clip.mov');
    assert.equal(avecExtension('son', 'audio/x-wav'), 'son');
    assert.equal(avecExtension('doc', 'application/zip'), 'doc.zip');
  });

  test('sans MIME : inchangé', () => {
    assert.equal(avecExtension('fichier', null), 'fichier');
  });
});

describe('versGalerie', () => {
  test('photo, vidéo, son : par le MIME ou par l’extension', () => {
    assert.equal(versGalerie('x', 'image/png'), true);
    assert.equal(versGalerie('x', 'video/mp4'), true);
    assert.equal(versGalerie('IMG_1.JPG', null), true);
    assert.equal(versGalerie('note.m4a', null), true);
  });

  test('le reste va dans un dossier', () => {
    assert.equal(versGalerie('rapport.pdf', 'application/pdf'), false);
    assert.equal(versGalerie('archive.zip', null), false);
    assert.equal(versGalerie('sans-extension', null), false);
  });
});

describe('telechargerFichierJoint', () => {
  test('nom sans extension : complété d’après le MIME', async () => {
    const destination = await telechargerFichierJoint({
      url: 'https://chat.example/file-upload/ab12/photo?rc_token=t',
      titre: null,
      type: 'image/jpeg',
      dossier: 'file:///cache',
      creerDossier: async () => {},
      telecharger: async () => {},
    });
    assert.equal(destination, 'file:///cache/jointes/ab12/photo.jpg');
  });
});

describe('fractionTelechargee', () => {
  test('la taille annoncée par la réponse d’abord', () => {
    assert.equal(fractionTelechargee(50, 200, 1000), 0.25);
  });

  test('réponse sans taille (chunked) : le poids du message prend le relais', () => {
    assert.equal(fractionTelechargee(250, -1, 1000), 0.25);
    assert.equal(fractionTelechargee(250, 0, 1000), 0.25);
  });

  test('plafonnée à 1, et null quand on ne sait rien', () => {
    assert.equal(fractionTelechargee(1500, -1, 1000), 1);
    assert.equal(fractionTelechargee(10, -1, null), null);
  });
});
