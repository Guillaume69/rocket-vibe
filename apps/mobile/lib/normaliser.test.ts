import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { versAbonnement, versEpoch, versMessage, versSalon } from './normaliser.ts';

const base = { _id: 'm1', rid: 'r1', ts: 1000, u: { _id: 'u1', username: 'alice' } };

describe('versMessage — message de visioconférence', () => {
  test('extrait le callId du bloc video_conf (pas du _id)', () => {
    // Sur la source RC, le callId vit dans le bloc ; le _id du message diffère.
    const m = versMessage({
      ...base,
      t: 'videoconf',
      msg: '',
      blocks: [
        { type: 'video_conf', blockId: 'call-abc', callId: 'call-abc', appId: 'videoconf-core' },
      ],
    });
    assert.equal(m?.typeSysteme, 'videoconf');
    assert.equal(m?.appelId, 'call-abc');
  });

  test('un bloc sans callId ni type attendu laisse appelId à null', () => {
    const m = versMessage({ ...base, t: 'videoconf', blocks: [{ type: 'section' }] });
    assert.equal(m?.appelId, null);
  });

  test('un message ordinaire n’a pas d’appelId, même avec des blocks', () => {
    // On ne lit les blocs QUE pour un `t: 'videoconf'` : pas de faux positif.
    const m = versMessage({
      ...base,
      msg: 'coucou',
      blocks: [{ type: 'video_conf', callId: 'call-xyz' }],
    });
    assert.equal(m?.typeSysteme, null);
    assert.equal(m?.appelId, null);
  });
});

describe('versEpoch — les trois formes que le serveur envoie', () => {
  test('un nombre passe tel quel', () => {
    assert.equal(versEpoch(1_700_000_000_000), 1_700_000_000_000);
  });

  test('une chaîne ISO est parsée', () => {
    assert.equal(versEpoch('2026-07-25T10:00:00.000Z'), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('la forme EJSON { $date } est déballée, nombre comme chaîne', () => {
    assert.equal(versEpoch({ $date: 1234 }), 1234);
    assert.equal(versEpoch({ $date: '2026-07-25T10:00:00.000Z' }), Date.parse('2026-07-25T10:00:00.000Z'));
  });

  test('tout le reste rend null, jamais NaN', () => {
    // Un NaN qui part en base y reste : SQLite l'accepte, et toute comparaison
    // d'horodatage devient fausse en silence.
    for (const v of [undefined, null, '', 'pas une date', {}, { $date: 'pas une date' }, [], true, NaN, Infinity]) {
      assert.equal(versEpoch(v), null, `${JSON.stringify(v) ?? String(v)} devrait rendre null`);
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
    const s = versSalon(dm(), MOI, MON_UID);
    assert.equal(s?.dmAutreUid, 'uBob');
    assert.equal(s?.dmAutreUsername, 'bob');
    assert.equal(s?.nomAffiche, 'bob');
  });

  test('uids et usernames NE SONT PAS alignés : l’appariement n’est pas par index', () => {
    // Vérifié sur 8.5. Un appariement positionnel rendrait ici « guillaume »
    // pour l'uid de Bob — donc MON pseudo, et mon avatar, collés sur lui.
    const s = versSalon(dm({ uids: [MON_UID, 'uBob'], usernames: ['bob', MOI] }), MOI, MON_UID);
    assert.equal(s?.dmAutreUid, 'uBob');
    assert.equal(s?.dmAutreUsername, 'bob');
  });

  test('MOI PÉRIMÉ (renommé depuis le web) : on ne devine pas, on se tait', () => {
    // C'est le cœur du défaut : `moi` est figé à la construction du traducteur.
    // Sans preuve que je figure dans `usernames`, exclure « celui qui n'est pas
    // moi » retient le PREMIER venu — moi une fois sur deux — et ce pseudo part
    // en base sous l'uid de l'autre, SANS garde d'horodatage.
    const s = versSalon(dm({ usernames: ['ancien-pseudo', 'bob'] }), MOI, MON_UID);
    assert.equal(s?.dmAutreUid, 'uBob', 'l’uid, lui, reste sûr');
    assert.equal(s?.dmAutreUsername, null, 'aucune identité inventée');
  });

  test('session sans pseudo (username vide) : même prudence', () => {
    assert.equal(versSalon(dm(), '', MON_UID)?.dmAutreUsername, null);
    assert.equal(versSalon(dm(), null, MON_UID)?.dmAutreUsername, null);
    assert.equal(versSalon(dm(), undefined, MON_UID)?.dmAutreUsername, null);
  });

  test('DM avec soi-même : je suis mon propre correspondant', () => {
    const s = versSalon(dm({ uids: [MON_UID], usernames: [MOI] }), MOI, MON_UID);
    assert.equal(s?.dmAutreUid, MON_UID);
    assert.equal(s?.dmAutreUsername, MOI);
    assert.equal(s?.nomAffiche, MOI);
  });

  test('DM de GROUPE : pas UNE présence à montrer, donc pas de correspondant', () => {
    const s = versSalon(dm({ uids: [MON_UID, 'uBob', 'uCarol'], usernames: [MOI, 'bob', 'carol'] }), MOI, MON_UID);
    assert.equal(s?.dmAutreUid, null);
    assert.equal(s?.dmAutreUsername, null);
    assert.equal(s?.nomAffiche, 'bob, carol');
  });

  test('sans mon uid, aucun correspondant n’est dérivé', () => {
    assert.equal(versSalon(dm(), MOI)?.dmAutreUid, null);
    assert.equal(versSalon(dm(), MOI)?.dmAutreUsername, null);
  });

  test('fname l’emporte sur le nom dérivé des usernames', () => {
    assert.equal(versSalon(dm({ fname: 'Bob Martin' }), MOI, MON_UID)?.nomAffiche, 'Bob Martin');
  });
});

describe('versSalon — aperçu du dernier message', () => {
  const salon = (lastMessage?: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    versSalon({ _id: 'r1', t: 'c', _updatedAt: { $date: 100 }, ...o, ...(lastMessage ? { lastMessage } : {}) });

  test('le texte du message', () => {
    const s = salon({ _id: 'm1', msg: 'coucou', ts: { $date: 50 } });
    assert.equal(s?.dernierMessage, 'coucou');
    assert.equal(s?.dernierMessageType, null);
    assert.equal(s?.horodatageDernierMessage, 50);
  });

  test('un message qui n’est QU’une pièce jointe retombe sur sa légende, sinon son nom', () => {
    // `msg: ''` est la forme d'un upload sondée sur 8.5.
    assert.equal(
      salon({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf', description: 'le compte-rendu' }] })
        ?.dernierMessage,
      'le compte-rendu',
    );
    assert.equal(
      salon({ _id: 'm1', msg: '', attachments: [{ title: 'note.pdf' }] })?.dernierMessage,
      'note.pdf',
    );
  });

  test('APPEL VIDÉO : pas de texte, mais un type — la ligne ne sera pas vide', () => {
    // Son contenu vit dans `blocks`. Sans le type, l'aperçu tombait à null et
    // le salon remontait en tête de liste avec une ligne blanche.
    const s = salon({ _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } });
    assert.equal(s?.dernierMessage, null);
    assert.equal(s?.dernierMessageType, 'videoconf');
  });

  test('salon VIDÉ : plus de lastMessage du tout, les deux à null', () => {
    // La seule façon d'apprendre qu'un salon a été vidé — à ne pas confondre
    // avec « dernier message sans texte à montrer ».
    const s = salon(undefined, { lm: { $date: 40 } });
    assert.equal(s?.dernierMessage, null);
    assert.equal(s?.dernierMessageType, null);
    assert.equal(s?.horodatageDernierMessage, 40, 'lm survit à la suppression');
  });

  test('salon CHIFFRÉ : ni aperçu ni type, le serveur ne détient que du ciphertext', () => {
    const s = salon({ _id: 'm1', msg: 'AAAAbase64==', t: 'e2e', ts: { $date: 50 } }, { encrypted: true });
    assert.equal(s?.chiffre, true);
    assert.equal(s?.dernierMessage, null);
    assert.equal(s?.dernierMessageType, null);
  });

  test('avatarETag ABSENT vaut null — « rien à dire », pas « efface »', () => {
    assert.equal(salon()?.avatarEtag, null);
    assert.equal(versSalon({ _id: 'r1', t: 'c', avatarETag: 'abc' })?.avatarEtag, 'abc');
  });

  test('sans _updatedAt, misAJourLe vaut 0 — le document le plus vieux possible', () => {
    // Il arbitre le `WHERE excluded.mis_a_jour_le >=` de l'UPSERT : un défaut à
    // « maintenant » ferait gagner un document partiel sur un document frais.
    assert.equal(versSalon({ _id: 'r1', t: 'c' })?.misAJourLe, 0);
  });

  test('un document sans _id ou sans t n’est pas normalisable', () => {
    assert.equal(versSalon({ t: 'c' }), null);
    assert.equal(versSalon({ _id: 'r1' }), null);
  });
});

describe('versAbonnement', () => {
  test('les compteurs absents valent 0, les drapeaux false', () => {
    const a = versAbonnement({ rid: 'r1' });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: null,
      nonLus: 0,
      mentions: 0,
      mentionsGroupe: 0,
      alerte: false,
      ouvert: false,
      favori: false,
      luJusquA: null,
      e2eKey: null,
      e2eKeyId: null,
      misAJourLe: 0,
    });
  });

  test('un abonnement complet est repris champ par champ', () => {
    const a = versAbonnement({
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
      _updatedAt: { $date: 1000 },
    });
    assert.deepEqual(a, {
      rid: 'r1',
      subId: 's1',
      nonLus: 3,
      mentions: 1,
      mentionsGroupe: 2,
      alerte: true,
      ouvert: true,
      favori: true,
      luJusquA: 900,
      e2eKey: 'kid+base64',
      e2eKeyId: 'kid',
      misAJourLe: 1000,
    });
  });

  test('sans rid, rien à écrire', () => {
    assert.equal(versAbonnement({ _id: 's1' }), null);
  });

  test('un drapeau « truthy » qui n’est pas true reste false', () => {
    // `booleen` compare à `true` : un 1 ou une chaîne venus d'une charge
    // inattendue ne doivent pas allumer une pastille de non-lus.
    const a = versAbonnement({ rid: 'r1', alert: 1, open: 'oui' });
    assert.equal(a?.alerte, false);
    assert.equal(a?.ouvert, false);
  });
});
