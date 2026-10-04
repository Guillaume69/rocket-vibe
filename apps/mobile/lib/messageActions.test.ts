import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  actionsPossibles,
  messageGoneFromServer,
  rulesFromSettings,
  textToCopy,
} from './messageActions.ts';
import { RestError } from './rest.ts';

const regles = {
  editAllowed: true,
  editBlockMinutes: 5,
  deleteAllowed: true,
  deleteBlockMinutes: 0,
  pinAllowed: true,
  starAllowed: true,
};

const base = {
  message: {
    authorId: 'moi',
    ts: 1_000_000,
    systemType: null,
    text: 'coucou',
    attachments: null as string | null,
    pinned: false,
    starred: false,
  },
  me: 'moi',
  rules: regles,
  permissions: null as string[] | null,
  readOnly: false,
  encrypted: false,
  inThread: false,
  now: 1_000_000 + 60_000, // une minute plus tard
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
    const tard = { ...base, now: base.message.ts + 6 * 60_000 };
    assert.deepEqual(actionsPossibles(tard), ['reagir', 'repondre', 'repondreFil', 'copier', 'partager', 'supprimer', 'epingler', 'etoiler']);
  });

  test('`bypass-time-limit-edit-and-delete` rouvre l’édition après le délai', () => {
    const admin = {
      ...base,
      now: base.message.ts + 6 * 60_000,
      permissions: ['bypass-time-limit-edit-and-delete'],
    };
    assert.ok(actionsPossibles(admin).includes('modifier'));
  });

  test('`edit-message` permet de modifier le message d’AUTRUI', () => {
    const moderateur = {
      ...base,
      message: { ...base.message, authorId: 'lui' },
      permissions: ['edit-message'],
    };
    assert.ok(actionsPossibles(moderateur).includes('modifier'));
  });

  test('le message d’AUTRUI ne se modifie ni ne se supprime (sans permission)', () => {
    const autrui = { ...base, message: { ...base.message, authorId: 'lui' } };
    assert.deepEqual(actionsPossibles(autrui), ['reagir', 'repondre', 'repondreFil', 'copier', 'partager', 'epingler', 'etoiler']);
  });

  test('lecture seule : ni réaction ni réponse ; message système : rien du tout', () => {
    const enLectureSeule = actionsPossibles({ ...base, readOnly: true });
    assert.ok(!enLectureSeule.includes('reagir'));
    assert.ok(!enLectureSeule.includes('repondre'));
    assert.ok(!enLectureSeule.includes('repondreFil'));
    assert.deepEqual(
      actionsPossibles({ ...base, message: { ...base.message, systemType: 'uj' } }),
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
      encrypted: true,
      message: { ...base.message, systemType: 'e2e', text: 'clair' },
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
        encrypted: true,
        message: { ...base.message, systemType: 'e2e', text: null },
      }),
      [],
    );
  });

  test('un vrai message système reste fermé, même avec un texte', () => {
    assert.deepEqual(
      actionsPossibles({
        ...base,
        message: { ...base.message, systemType: 'uj', text: 'a rejoint le salon' },
      }),
      [],
    );
  });

  test('depuis l’écran d’un fil : répondre, mais pas ouvrir un fil', () => {
    const actions = actionsPossibles({ ...base, inThread: true });
    assert.ok(actions.includes('repondre'));
    assert.ok(!actions.includes('repondreFil'));
  });

  test('lecture seule : copier et partager restent', () => {
    const enLectureSeule = actionsPossibles({ ...base, readOnly: true });
    assert.ok(enLectureSeule.includes('copier'));
    assert.ok(enLectureSeule.includes('partager'));
  });

  test('image sans légende : partager et enregistrer le fichier, mais rien à copier', () => {
    const image = JSON.stringify([
      { title: 'photo.jpg', title_link: '/file-upload/f1/photo.jpg', image_url: '/file-upload/t1/photo.jpg' },
    ]);
    const actions = actionsPossibles({
      ...base,
      message: { ...base.message, text: '', attachments: image },
    });
    assert.ok(actions.includes('partager'));
    assert.ok(actions.includes('enregistrer'));
    assert.ok(!actions.includes('copier'));
  });

  test('sans texte ni fichier, ou citation sans un mot : ni copier ni partager', () => {
    const lien = '[ ](https://chat.example/channel/general?msg=abc)';
    for (const texte of [null, '', '   ', lien, `${lien}  `]) {
      const actions = actionsPossibles({ ...base, message: { ...base.message, text: texte } });
      assert.ok(!actions.includes('copier'), String(texte));
      assert.ok(!actions.includes('partager'), String(texte));
    }
  });
});

describe('texteACopier', () => {
  test('retire le permalien de citation en tête', () => {
    assert.equal(
      textToCopy('[ ](https://chat.example/channel/general?msg=abc) oui, **ça** marche'),
      'oui, **ça** marche',
    );
  });

  test('rien à emporter : null', () => {
    assert.equal(textToCopy(null), null);
    assert.equal(textToCopy('  '), null);
  });
});

describe('reglesDepuisReglages', () => {
  test('lit les réglages et retombe sur permissif quand ils manquent', () => {
    const r = rulesFromSettings([
      { _id: 'Message_AllowEditing', value: true },
      { _id: 'Message_AllowEditing_BlockEditInMinutes', value: 5 },
      { _id: 'Message_AllowDeleting', value: false },
    ]);
    assert.equal(r.editBlockMinutes, 5);
    assert.equal(r.deleteAllowed, false);
    assert.equal(r.pinAllowed, true, 'absent = permis, le serveur tranchera');
    assert.equal(r.starAllowed, true);
    assert.equal(
      rulesFromSettings([{ _id: 'Message_AllowStarring', value: false }]).starAllowed,
      false,
    );
  });
});

describe('actionsPossibles — permissions chargées', () => {
  const autrui = { ...base.message, authorId: 'lui' };

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

    const tard = actionsPossibles({ ...moderateur, now: base.message.ts + 6 * 60_000 });
    assert.ok(!tard.includes('modifier'), 'le délai vaut aussi pour edit-message');
    assert.ok(tard.includes('supprimer'), 'délai de suppression illimité (0)');
  });

  test('force-delete-message supprime même hors délai et suppression désactivée', () => {
    const proprio = {
      ...base,
      message: autrui,
      rules: { ...regles, deleteAllowed: false, deleteBlockMinutes: 1 },
      now: base.message.ts + 60 * 60_000,
      permissions: ['force-delete-message'],
    };
    assert.ok(actionsPossibles(proprio).includes('supprimer'));
  });
});

describe('actionsPossibles — épingler, étoiler', () => {
  test('un message épinglé propose Désépingler, un message étoilé par moi Retirer des favoris', () => {
    const marque = { ...base, message: { ...base.message, pinned: true, starred: true } };
    const actions = actionsPossibles(marque);
    assert.ok(actions.includes('desepingler') && !actions.includes('epingler'));
    assert.ok(actions.includes('desetoiler') && !actions.includes('etoiler'));
  });

  test('réglages fermés : ni épingle ni étoile', () => {
    const ferme = {
      ...base,
      rules: { ...regles, pinAllowed: false, starAllowed: false },
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
    assert.equal(await messageGoneFromServer(c, 'm1'), false);
  });

  test('400 : le serveur ne connaît plus ce message — fantôme confirmé', async () => {
    const c = client(() =>
      Promise.reject(new RestError('No message found with the id of "m1".', 400)),
    );
    assert.equal(await messageGoneFromServer(c, 'm1'), true);
  });

  test('statut 0 (réseau) ou 429 (rate limit) : on ne conclut PAS à la disparition', async () => {
    const horsLigne = client(() => Promise.reject(new RestError('injoignable', 0)));
    assert.equal(await messageGoneFromServer(horsLigne, 'm1'), false);
    const limite = client(() => Promise.reject(new RestError('too many requests', 429)));
    assert.equal(await messageGoneFromServer(limite, 'm1'), false);
  });

  test('une erreur qui n’est pas une ErreurRest ne conclut pas non plus', async () => {
    const c = client(() => Promise.reject(new Error('boom')));
    assert.equal(await messageGoneFromServer(c, 'm1'), false);
  });
});
