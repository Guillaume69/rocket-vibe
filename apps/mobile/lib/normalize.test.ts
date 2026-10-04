import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toSubscription, toEpoch, toMessage, toRoom } from './normalize.ts';

const base = { _id: 'm1', rid: 'r1', ts: 1000, u: { _id: 'u1', username: 'alice' } };

describe('versMessage — message de visioconférence', () => {
  test('extrait le callId du bloc video_conf (pas du _id)', () => {
    // Sur la source RC, le callId vit dans le bloc ; le _id du message diffère.
    const m = toMessage({
      ...base,
      t: 'videoconf',
      msg: '',
      blocks: [
        { type: 'video_conf', blockId: 'call-abc', callId: 'call-abc', appId: 'videoconf-core' },
      ],
    });
    assert.equal(m?.systemType, 'videoconf');
    assert.equal(m?.callId, 'call-abc');
  });

  test('un bloc sans callId ni type attendu laisse appelId à null', () => {
    const m = toMessage({ ...base, t: 'videoconf', blocks: [{ type: 'section' }] });
    assert.equal(m?.callId, null);
  });

  test('un message ordinaire n’a pas d’appelId, même avec des blocks', () => {
    // On ne lit les blocs QUE pour un `t: 'videoconf'` : pas de faux positif.
    const m = toMessage({
      ...base,
      msg: 'coucou',
      blocks: [{ type: 'video_conf', callId: 'call-xyz' }],
    });
    assert.equal(m?.systemType, null);
    assert.equal(m?.callId, null);
  });
});

describe('versMessage — épinglage et étoiles', () => {
  test('lit `pinned` et réduit `starred` aux uids', () => {
    const m = toMessage({ ...base, msg: 'x', pinned: true, starred: [{ _id: 'u1' }, { _id: 'u2' }] });
    assert.equal(m?.pinned, true);
    assert.equal(m?.starred, '["u1","u2"]');
  });

  test('absents ou vides : ni épinglé ni étoilé', () => {
    const m = toMessage({ ...base, msg: 'x', starred: [] });
    assert.equal(m?.pinned, false);
    assert.equal(m?.starred, null);
  });
});

describe('versEpoch — les trois formes que le serveur envoie', () => {
  test('un nombre passe tel quel', () => {
    assert.equal(toEpoch(1_700_000_000_000), 1_700_000_000_000);
  });

  test('une chaîne ISO est parsée', () => {
    assert.equal(toEpoch('2026-07-25T10:00:00.000Z'), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('la forme EJSON { $date } est déballée, nombre comme chaîne', () => {
    assert.equal(toEpoch({ $date: 1234 }), 1234);
    assert.equal(toEpoch({ $date: '2026-07-25T10:00:00.000Z' }), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('tout le reste rend null, jamais NaN', () => {
    // Un NaN qui part en base y reste : SQLite l'accepte, et toute comparaison
    // d'horodatage devient fausse en silence.
    for (const v of [undefined, null, '', 'pas une date', {}, { $date: 'pas une date' }, [], true, NaN, Infinity]) {
      assert.equal(toEpoch(v), null, `${JSON.stringify(v) ?? String(v)} devrait rendre null`);
    }
  });
});

describe('versSalon — le DM et son correspondant', () => {
  const MOI = 'guillaume';
  const MON_UID = 'uMoi';
  const dm = (o: Record<string, unknown> = {}) => ({
    _id: 'r1',
    t: 'd',
    _updatedAt: { $date: 100 },
    uids: [MON_UID, 'uBob'],
    usernames: [MOI, 'bob'],
    ...o,
  });

  test('le correspondant est celui des deux qui n’est pas moi', () => {
    const s = toRoom(dm(), MOI, MON_UID);
    assert.equal(s?.dmOtherUid, 'uBob');
    assert.equal(s?.dmOtherUsername, 'bob');
    assert.equal(s?.displayName, 'bob');
  });

  test('uids et usernames NE SONT PAS alignés : l’appariement n’est pas par index', () => {
    // Vérifié sur 8.5. Un appariement positionnel rendrait ici « guillaume »
    // pour l'uid de Bob — donc MON pseudo, et mon avatar, collés sur lui.
    const s = toRoom(dm({ uids: [MON_UID, 'uBob'], usernames: ['bob', MOI] }), MOI, MON_UID);
    assert.equal(s?.dmOtherUid, 'uBob');
    assert.equal(s?.dmOtherUsername, 'bob');
  });

  test('MOI PÉRIMÉ (renommé depuis le web) : on ne devine pas, on se tait', () => {
    // C'est le cœur du défaut : `moi` est figé à la construction du traducteur.
    // Sans preuve que je figure dans `usernames`, exclure « celui qui n'est pas
    // moi » retient le PREMIER venu — moi une fois sur deux — et ce pseudo part
    // en base sous l'uid de l'autre, SANS garde d'horodatage.
    const s = toRoom(dm({ usernames: ['ancien-pseudo', 'bob'] }), MOI, MON_UID);
    assert.equal(s?.dmOtherUid, 'uBob', 'l’uid, lui, reste sûr');
    assert.equal(s?.dmOtherUsername, null, 'aucune identité inventée');
  });

  test('session sans pseudo (username vide) : même prudence', () => {
    assert.equal(toRoom(dm(), '', MON_UID)?.dmOtherUsername, null);
    assert.equal(toRoom(dm(), null, MON_UID)?.dmOtherUsername, null);
    assert.equal(toRoom(dm(), undefined, MON_UID)?.dmOtherUsername, null);
  });

  test('DM avec soi-même : je suis mon propre correspondant', () => {
    const s = toRoom(dm({ uids: [MON_UID], usernames: [MOI] }), MOI, MON_UID);
    assert.equal(s?.dmOtherUid, MON_UID);
    assert.equal(s?.dmOtherUsername, MOI);
    assert.equal(s?.displayName, MOI);
  });

  test('DM de GROUPE : pas UNE présence à montrer, donc pas de correspondant', () => {
    const s = toRoom(dm({ uids: [MON_UID, 'uBob', 'uCarol'], usernames: [MOI, 'bob', 'carol'] }), MOI, MON_UID);
    assert.equal(s?.dmOtherUid, null);
    assert.equal(s?.dmOtherUsername, null);
    assert.equal(s?.displayName, 'bob, carol');
  });

  test('sans mon uid, aucun correspondant n’est dérivé', () => {
    assert.equal(toRoom(dm(), MOI)?.dmOtherUid, null);
    assert.equal(toRoom(dm(), MOI)?.dmOtherUsername, null);
  });

  test('fname l’emporte sur le nom dérivé des usernames', () => {
    assert.equal(toRoom(dm({ fname: 'Bob Martin' }), MOI, MON_UID)?.displayName, 'Bob Martin');
  });
});

describe('versSalon — aperçu du dernier message', () => {
  const salon = (lastMessage?: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    toRoom({ _id: 'r1', t: 'c', _updatedAt: { $date: 100 }, ...o, ...(lastMessage ? { lastMessage } : {}) });

  test('le texte du message', () => {
    const s = salon({ _id: 'm1', msg: 'coucou', ts: { $date: 50 } });
    assert.equal(s?.lastMessage, 'coucou');
    assert.equal(s?.lastMessageType, null);
    assert.equal(s?.lastMessageTs, 50);
  });

  test('un message qui n’est QU’une pièce jointe retombe sur sa légende, sinon son nom', () => {
    // `msg: ''` est la forme d'un upload sondée sur 8.5.
    assert.equal(
      salon({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf', description: 'le compte-rendu' }] })
        ?.lastMessage,
      'le compte-rendu',
    );
    assert.equal(
      salon({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf' }] })?.lastMessage,
      'note.pdf',
    );
  });

  test('APPEL VIDÉO : pas de texte, mais un type — la ligne ne sera pas vide', () => {
    // Son contenu vit dans `blocks`. Sans le type, l'aperçu tombait à null et
    // le salon remontait en tête de liste avec une ligne blanche.
    const s = salon({ _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } });
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, 'videoconf');
  });

  test('salon VIDÉ : plus de lastMessage du tout, les deux à null', () => {
    // La seule façon d'apprendre qu'un salon a été vidé — à ne pas confondre
    // avec « dernier message sans texte à montrer ».
    const s = salon(undefined, { lm: { $date: 40 } });
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, null);
    assert.equal(s?.lastMessageTs, 40, 'lm survit à la suppression');
  });

  test('salon CHIFFRÉ : ni aperçu ni type, le serveur ne détient que du ciphertext', () => {
    const s = salon({ _id: 'm1', msg: 'AAAAbase64==', t: 'e2e', ts: { $date: 50 } }, { encrypted: true });
    assert.equal(s?.encrypted, true);
    assert.equal(s?.lastMessage, null);
    assert.equal(s?.lastMessageType, null);
  });

  test('avatarETag ABSENT vaut null — « rien à dire », pas « efface »', () => {
    assert.equal(salon()?.avatarEtag, null);
    assert.equal(toRoom({ _id: 'r1', t: 'c', avatarETag: 'abc' })?.avatarEtag, 'abc');
  });

  test('sans _updatedAt, misAJourLe vaut 0 — le document le plus vieux possible', () => {
    // Il arbitre le `WHERE excluded.mis_a_jour_le >=` de l'UPSERT : un défaut à
    // « maintenant » ferait gagner un document partiel sur un document frais.
    assert.equal(toRoom({ _id: 'r1', t: 'c' })?.updatedAt, 0);
  });

  test('un document sans _id ou sans t n’est pas normalisable', () => {
    assert.equal(toRoom({ t: 'c' }), null);
    assert.equal(toRoom({ _id: 'r1' }), null);
  });
});

describe('versAbonnement', () => {
  test('les compteurs absents valent 0, les drapeaux false', () => {
    const a = toSubscription({ rid: 'r1' });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: null,
      unread: 0,
      mentions: 0,
      groupMentions: 0,
      alert: false,
      open: false,
      favorite: false,
      lastSeen: null,
      e2eKey: null,
      e2eKeyId: null,
      roles: null,
      updatedAt: 0,
    });
  });

  test('un abonnement complet est repris champ par champ', () => {
    const a = toSubscription({
      _id: 's1',
      rid: 'r1',
      unread: 3,
      userMentions: 1,
      groupMentions: 2,
      alert: true,
      open: true,
      f: true,
      ls: { $date: 900 },
      E2EKey: 'kid+base64',
      e2eKeyId: 'kid',
      roles: ['owner', 7],
      _updatedAt: { $date: 1000 },
    });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: 's1',
      unread: 3,
      mentions: 1,
      groupMentions: 2,
      alert: true,
      open: true,
      favorite: true,
      lastSeen: 900,
      e2eKey: 'kid+base64',
      e2eKeyId: 'kid',
      roles: '["owner"]',
      updatedAt: 1000,
    });
  });

  test('sans rid, rien à écrire', () => {
    assert.equal(toSubscription({ _id: 's1' }), null);
  });

  test('un drapeau « truthy » qui n’est pas true reste false', () => {
    // `booleen` compare à `true` : un 1 ou une chaîne venus d'une charge
    // inattendue ne doivent pas allumer une pastille de non-lus.
    const a = toSubscription({ rid: 'r1', alert: 1, open: 'oui' });
    assert.equal(a?.alert, false);
    assert.equal(a?.open, false);
  });
});
