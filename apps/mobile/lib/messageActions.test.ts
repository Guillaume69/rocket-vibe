import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  actionsPossibles,
  messageDisparuDuServeur,
  reglesDepuisReglages,
  texteACopier,
} from './messageActions.ts';
import { ErreurRest } from './rest.ts';

const regles = {
  editionAutorisee: true,
  minutesBlocageEdition: 5,
  suppressionAutorisee: true,
  minutesBlocageSuppression: 0,
  epinglageAutorise: true,
  etoilageAutorise: true,
};

const base = {
  message: {
    auteurId: 'moi',
    horodatage: 1_000_000,
    typeSysteme: null,
    texte: 'coucou',
    piecesJointes: null as string | null,
    epingle: false,
    etoile: false,
  },
  moi: 'moi',
  regles,
  permissions: null as string[] | null,
  lectureSeule: false,
  chiffre: false,
  dansUnFil: false,
  maintenant: 1_000_000 + 60_000, // une minute plus tard
};

describe('actionsPossibles', () => {
  test('mon message récent : tout est permis', () => {
    assert.deepEqual(actionsPossibles(base), [
      'reagir',
      'repondre',
      'repondreFil',
      'copier',
      'partager',
      'modifier',
      'supprimer',
      'epingler',
      'etoiler',
    ]);
  });

  test('le DÉLAI d’édition vient des settings, pas des permissions', () => {
    // 6 minutes après, avec BlockEditInMinutes = 5 : plus d'édition —
    // mais la suppression (délai 0 = illimité) reste.
    const tard = { ...base, maintenant: base.message.horodatage + 6 * 60_000 };
    assert.deepEqual(actionsPossibles(tard), ['reagir', 'repondre', 'repondreFil', 'copier', 'partager', 'supprimer', 'epingler', 'etoiler']);
  });

  test('`bypass-time-limit-edit-and-delete` rouvre l’édition après le délai', () => {
    const admin = {
      ...base,
      maintenant: base.message.horodatage + 6 * 60_000,
      permissions: ['bypass-time-limit-edit-and-delete'],
    };
    assert.ok(actionsPossibles(admin).includes('modifier'));
  });

  test('`edit-message` permet de modifier le message d’AUTRUI', () => {
    const moderateur = {
      ...base,
      message: { ...base.message, auteurId: 'lui' },
      permissions: ['edit-message'],
    };
    assert.ok(actionsPossibles(moderateur).includes('modifier'));
  });

  test('le message d’AUTRUI ne se modifie ni ne se supprime (sans permission)', () => {
    const autrui = { ...base, message: { ...base.message, auteurId: 'lui' } };
    assert.deepEqual(actionsPossibles(autrui), ['reagir', 'repondre', 'repondreFil', 'copier', 'partager', 'epingler', 'etoiler']);
  });

  test('lecture seule : ni réaction ni réponse ; message système : rien du tout', () => {
    const enLectureSeule = actionsPossibles({ ...base, lectureSeule: true });
    assert.ok(!enLectureSeule.includes('reagir'));
    assert.ok(!enLectureSeule.includes('repondre'));
    assert.ok(!enLectureSeule.includes('repondreFil'));
    assert.deepEqual(
      actionsPossibles({ ...base, message: { ...base.message, typeSysteme: 'uj' } }),
      [],
    );
  });

  // Ces trois cas remplacent un test qui passait `chiffre: true` en laissant
  // `typeSysteme: null` — une combinaison qui n'existe PAS en base : un message
  // d'un salon chiffré porte toujours le marqueur `e2e`, que `db/upserts.ts` ne
  // retire pas au déchiffrement. Le test affirmait donc « réagir reste » alors
  // que la sortie sèche sur `typeSysteme !== null` rendait un tableau vide.
  test('salon chiffré, message DÉCHIFFRÉ : tout, sauf répondre en citant', () => {
    const lisible = actionsPossibles({
      ...base,
      chiffre: true,
      message: { ...base.message, typeSysteme: 'e2e', texte: 'clair' },
    });
    assert.deepEqual(lisible, ['reagir', 'repondreFil', 'copier', 'partager', 'modifier', 'supprimer', 'epingler', 'etoiler']);
    // La carte de citation est bâtie par le serveur depuis le texte, qu'il ne
    // lit pas dans un salon chiffré.
    assert.ok(!lisible.includes('repondre'));
  });

  test('salon chiffré, message ENCORE OPAQUE : aucune action', () => {
    assert.deepEqual(
      actionsPossibles({
        ...base,
        chiffre: true,
        message: { ...base.message, typeSysteme: 'e2e', texte: null },
      }),
      [],
    );
  });

  test('un vrai message système reste fermé, même avec un texte', () => {
    assert.deepEqual(
      actionsPossibles({
        ...base,
        message: { ...base.message, typeSysteme: 'uj', texte: 'a rejoint le salon' },
      }),
      [],
    );
  });

  test('depuis l’écran d’un fil : répondre, mais pas ouvrir un fil', () => {
    const actions = actionsPossibles({ ...base, dansUnFil: true });
    assert.ok(actions.includes('repondre'));
    assert.ok(!actions.includes('repondreFil'));
  });

  test('lecture seule : copier et partager restent', () => {
    const enLectureSeule = actionsPossibles({ ...base, lectureSeule: true });
    assert.ok(enLectureSeule.includes('copier'));
    assert.ok(enLectureSeule.includes('partager'));
  });

  test('image sans légende : partager et enregistrer le fichier, mais rien à copier', () => {
    const image = JSON.stringify([
      { title: 'photo.jpg', title_link: '/file-upload/f1/photo.jpg', image_url: '/file-upload/t1/photo.jpg' },
    ]);
    const actions = actionsPossibles({
      ...base,
      message: { ...base.message, texte: '', piecesJointes: image },
    });
    assert.ok(actions.includes('partager'));
    assert.ok(actions.includes('enregistrer'));
    assert.ok(!actions.includes('copier'));
  });

  test('sans texte ni fichier, ou citation sans un mot : ni copier ni partager', () => {
    const lien = '[ ](https://chat.example/channel/general?msg=abc)';
    for (const texte of [null, '', '   ', lien, `${lien}  `]) {
      const actions = actionsPossibles({ ...base, message: { ...base.message, texte } });
      assert.ok(!actions.includes('copier'), String(texte));
      assert.ok(!actions.includes('partager'), String(texte));
    }
  });
});

describe('texteACopier', () => {
  test('retire le permalien de citation en tête', () => {
    assert.equal(
      texteACopier('[ ](https://chat.example/channel/general?msg=abc) oui, **ça** marche'),
      'oui, **ça** marche',
    );
  });

  test('rien à emporter : null', () => {
    assert.equal(texteACopier(null), null);
    assert.equal(texteACopier('  '), null);
  });
});

describe('reglesDepuisReglages', () => {
  test('lit les réglages et retombe sur permissif quand ils manquent', () => {
    const r = reglesDepuisReglages([
      { _id: 'Message_AllowEditing', value: true },
      { _id: 'Message_AllowEditing_BlockEditInMinutes', value: 5 },
      { _id: 'Message_AllowDeleting', value: false },
    ]);
    assert.equal(r.minutesBlocageEdition, 5);
    assert.equal(r.suppressionAutorisee, false);
    assert.equal(r.epinglageAutorise, true, 'absent = permis, le serveur tranchera');
    assert.equal(r.etoilageAutorise, true);
    assert.equal(
      reglesDepuisReglages([{ _id: 'Message_AllowStarring', value: false }]).etoilageAutorise,
      false,
    );
  });
});

describe('actionsPossibles — permissions chargées', () => {
  const autrui = { ...base.message, auteurId: 'lui' };

  test('simple membre : ses messages oui, pas d’épingle', () => {
    const membre = { ...base, permissions: ['delete-own-message'] };
    const actions = actionsPossibles(membre);
    assert.ok(actions.includes('modifier') && actions.includes('supprimer'));
    assert.ok(!actions.includes('epingler'));
  });

  test('sans delete-own-message, même son propre message ne se supprime pas', () => {
    assert.ok(!actionsPossibles({ ...base, permissions: [] }).includes('supprimer'));
  });

  test('modérateur : modifie, supprime et épingle le message d’autrui, dans le délai', () => {
    const moderateur = {
      ...base,
      message: autrui,
      permissions: ['edit-message', 'delete-message', 'pin-message'],
    };
    const actions = actionsPossibles(moderateur);
    for (const x of ['modifier', 'supprimer', 'epingler'] as const) assert.ok(actions.includes(x), x);

    const tard = actionsPossibles({ ...moderateur, maintenant: base.message.horodatage + 6 * 60_000 });
    assert.ok(!tard.includes('modifier'), 'le délai vaut aussi pour edit-message');
    assert.ok(tard.includes('supprimer'), 'délai de suppression illimité (0)');
  });

  test('force-delete-message supprime même hors délai et suppression désactivée', () => {
    const proprio = {
      ...base,
      message: autrui,
      regles: { ...regles, suppressionAutorisee: false, minutesBlocageSuppression: 1 },
      maintenant: base.message.horodatage + 60 * 60_000,
      permissions: ['force-delete-message'],
    };
    assert.ok(actionsPossibles(proprio).includes('supprimer'));
  });
});

describe('actionsPossibles — épingler, étoiler', () => {
  test('un message épinglé propose Désépingler, un message étoilé par moi Retirer des favoris', () => {
    const marque = { ...base, message: { ...base.message, epingle: true, etoile: true } };
    const actions = actionsPossibles(marque);
    assert.ok(actions.includes('desepingler') && !actions.includes('epingler'));
    assert.ok(actions.includes('desetoiler') && !actions.includes('etoiler'));
  });

  test('réglages fermés : ni épingle ni étoile', () => {
    const ferme = {
      ...base,
      regles: { ...regles, epinglageAutorise: false, etoilageAutorise: false },
    };
    const actions = actionsPossibles(ferme);
    for (const a of ['epingler', 'desepingler', 'etoiler', 'desetoiler'] as const) {
      assert.ok(!actions.includes(a), a);
    }
  });
});

describe('messageDisparuDuServeur', () => {
  const client = (get: () => Promise<unknown>) => ({ get });

  test('chat.getMessage répond : le message existe encore, vrai refus', async () => {
    const c = client(() => Promise.resolve({ message: { _id: 'm1' } }));
    assert.equal(await messageDisparuDuServeur(c, 'm1'), false);
  });

  test('400 : le serveur ne connaît plus ce message — fantôme confirmé', async () => {
    const c = client(() =>
      Promise.reject(new ErreurRest('No message found with the id of "m1".', 400)),
    );
    assert.equal(await messageDisparuDuServeur(c, 'm1'), true);
  });

  test('statut 0 (réseau) ou 429 (rate limit) : on ne conclut PAS à la disparition', async () => {
    const horsLigne = client(() => Promise.reject(new ErreurRest('injoignable', 0)));
    assert.equal(await messageDisparuDuServeur(horsLigne, 'm1'), false);
    const limite = client(() => Promise.reject(new ErreurRest('too many requests', 429)));
    assert.equal(await messageDisparuDuServeur(limite, 'm1'), false);
  });

  test('une erreur qui n’est pas une ErreurRest ne conclut pas non plus', async () => {
    const c = client(() => Promise.reject(new Error('boom')));
    assert.equal(await messageDisparuDuServeur(c, 'm1'), false);
  });
});
