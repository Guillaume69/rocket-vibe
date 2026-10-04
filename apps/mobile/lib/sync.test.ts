import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent } from './ddp.ts';
import {
  toSubscription,
  toEpoch,
  toMessage,
  toRoom,
  type LocalSubscription,
  type MessageLocal,
  type LocalRoom,
} from './normalize.ts';
import { withTransactionTrap } from './testStore.ts';
import { SyncEngine, type E2EDecryptor, type Store } from './sync.ts';
import { AVATAR_NO_PHOTO } from './upload.ts';
import { RcTranslator } from '../providers/rocketchat/translator.ts';

describe('versEpoch', () => {
  test('accepte l’EJSON de Rocket.Chat', () => {
    assert.equal(toEpoch({ $date: 1_700_000_000_000 }), 1_700_000_000_000);
  });
  test('accepte une chaîne ISO', () => {
    assert.equal(toEpoch('2026-07-10T00:00:00.000Z'), Date.parse('2026-07-10T00:00:00.000Z'));
  });
  test('accepte un nombre brut', () => {
    assert.equal(toEpoch(42), 42);
  });
  test('rend null sur ce qu’il ne comprend pas, plutôt que NaN', () => {
    assert.equal(toEpoch(undefined), null);
    assert.equal(toEpoch('pas une date'), null);
    assert.equal(toEpoch({}), null);
  });
});

describe('versMessage', () => {
  const base = {
    _id: 'm1',
    rid: 'r1',
    msg: 'bonjour',
    ts: { $date: 1000 },
    u: { _id: 'u1', username: 'alice' },
    _updatedAt: { $date: 2000 },
  };

  test('traduit un message ordinaire', () => {
    const m = toMessage(base) as MessageLocal;
    assert.equal(m.id, 'm1');
    assert.equal(m.text, 'bonjour');
    assert.equal(m.ts, 1000);
    assert.equal(m.updatedAt, 2000);
    assert.equal(m.authorName, 'alice');
    assert.equal(m.systemType, null);
  });

  test('un message chiffré ne stocke JAMAIS son contenu', () => {
    const m = toMessage({ ...base, t: 'e2e', msg: 'blob-base64-opaque' }) as MessageLocal;
    assert.equal(m.systemType, 'e2e');
    assert.equal(m.text, null, 'le blob ne doit pas atteindre la base');
    assert.equal(m.md, null);
    assert.equal(m.attachments, null);
  });

  test('`_updatedAt` absent retombe sur l’horodatage du message', () => {
    const { _updatedAt, ...sans } = base;
    void _updatedAt;
    const m = toMessage(sans) as MessageLocal;
    assert.equal(m.updatedAt, 1000);
  });

  test('un document sans `_id`, `rid`, `ts` ou auteur est rejeté', () => {
    assert.equal(toMessage({ ...base, _id: undefined }), null);
    assert.equal(toMessage({ ...base, rid: undefined }), null);
    assert.equal(toMessage({ ...base, ts: undefined }), null);
    assert.equal(toMessage({ ...base, u: {} }), null);
  });

  test('`md` et `attachments` sont sérialisés, `undefined` devient null', () => {
    const m = toMessage({ ...base, md: [{ type: 'PARAGRAPH' }] }) as MessageLocal;
    assert.equal(m.md, '[{"type":"PARAGRAPH"}]');
    assert.equal(m.attachments, null);
  });

  test('`urls` (métadonnées de lien serveur) est sérialisé ; absent → null', () => {
    const avec = toMessage({ ...base, urls: [{ url: 'https://x', meta: { ogTitle: 'T' } }] }) as MessageLocal;
    assert.equal(avec.urls, '[{"url":"https://x","meta":{"ogTitle":"T"}}]');
    assert.equal((toMessage(base) as MessageLocal).urls, null);
    // Un salon chiffré ne stocke jamais d'aperçu.
    assert.equal((toMessage({ ...base, t: 'e2e', urls: [{ url: 'https://x' }] }) as MessageLocal).urls, null);
  });

  test('fils : `tmid`, `tcount`, `tlm` et `tshow` sont capturés (8.3)', () => {
    const racine = toMessage({
      ...base,
      tcount: 3,
      tlm: { $date: 5000 },
    }) as MessageLocal;
    assert.equal(racine.threadCount, 3);
    assert.equal(racine.threadLast, 5000);
    assert.equal(racine.threadId, null);
    assert.equal(racine.threadShown, false);

    const reponse = toMessage({ ...base, _id: 'm2', tmid: 'm1', tshow: true }) as MessageLocal;
    assert.equal(reponse.threadId, 'm1');
    assert.equal(reponse.threadShown, true, 'tshow = aussi visible dans le flux principal');
  });
});

describe('versSalon', () => {
  test('un salon chiffré n’expose pas d’aperçu', () => {
    const s = toRoom({
      _id: 'r1',
      t: 'p',
      name: 'laprivitude',
      encrypted: true,
      lastMessage: { msg: 'ciphertext', ts: { $date: 5 } },
      _updatedAt: { $date: 9 },
    }) as LocalRoom;
    assert.equal(s.encrypted, true);
    assert.equal(s.lastMessage, null, "l'aperçu d'un salon chiffré est du ciphertext");
    assert.equal(s.lastMessageTs, 5, 'mais son horodatage sert au tri');
  });

  test('un message SANS TEXTE (pièce jointe seule) donne quand même un aperçu', () => {
    // Sondé sur 8.5 : un message qui n'est qu'un fichier a `msg: ''`. Sans
    // repli, la liste gardait l'aperçu du message PRÉCÉDENT — elle annonçait
    // un échange qui n'était plus le dernier.
    const sansLegende = toRoom({
      _id: 'r1',
      t: 'c',
      lastMessage: { msg: '', attachments: [{ title: 'photo.jpg' }] },
    }) as LocalRoom;
    assert.equal(sansLegende.lastMessage, 'photo.jpg');

    const avecLegende = toRoom({
      _id: 'r1',
      t: 'c',
      lastMessage: { msg: '', attachments: [{ title: 'photo.jpg', description: 'le chat' }] },
    }) as LocalRoom;
    assert.equal(avecLegende.lastMessage, 'le chat', 'la légende prime sur le nom du fichier');
  });

  test('salon VIDÉ : `lastMessage` disparaît, l’aperçu doit devenir null', () => {
    // Supprimer le dernier message retire le champ du document Room. C'est le
    // seul signal disponible — l'UPSERT s'en sert pour EFFACER l'aperçu.
    const s = toRoom({ _id: 'r1', t: 'c', lm: { $date: 5 } }) as LocalRoom;
    assert.equal(s.lastMessage, null);
    assert.equal(s.lastMessageTs, 5, 'mais `lm` survit, et le tri avec');
  });

  test('`fname` prime sur `name` pour l’affichage', () => {
    const s = toRoom({ _id: 'r1', t: 'c', name: 'slug', fname: 'Nom Affiché' }) as LocalRoom;
    assert.equal(s.displayName, 'Nom Affiché');
    assert.equal(s.name, 'slug');
  });

  test('sans `fname`, on retombe sur `name`', () => {
    const s = toRoom({ _id: 'r1', t: 'c', name: 'slug' }) as LocalRoom;
    assert.equal(s.displayName, 'slug');
  });

  test('un DM sans nom se nomme depuis `usernames`, en s’excluant soi-même', () => {
    // `rooms.get` renvoie les DM sans `name` ni `fname` : seul `usernames`
    // permet de les nommer, et il contient AUSSI l'utilisateur courant.
    const s = toRoom({ _id: 'r1', t: 'd', usernames: ['alice', 'bob'] }, 'alice') as LocalRoom;
    assert.equal(s.displayName, 'bob');
  });

  test('un DM avec soi-même garde son propre nom', () => {
    const s = toRoom({ _id: 'r1', t: 'd', usernames: ['alice'] }, 'alice') as LocalRoom;
    assert.equal(s.displayName, 'alice');
  });

  test('un DM de groupe joint les autres participants', () => {
    const s = toRoom(
      { _id: 'r1', t: 'd', usernames: ['alice', 'bob', 'carol'] },
      'alice',
    ) as LocalRoom;
    assert.equal(s.displayName, 'bob, carol');
  });
});

describe('versSalon — dmAutreUid (8.4)', () => {
  test('extrait l’autre uid d’un DM à deux ; jamais pour un groupe ou sans moiUid', () => {
    const brut = { _id: 'r1', t: 'd', uids: ['moi-uid', 'lui-uid'], usernames: ['alice', 'bob'] };
    assert.equal(toRoom(brut, 'alice', 'moi-uid')?.dmOtherUid, 'lui-uid');
    // DM avec soi-même : l'autre, c'est moi.
    assert.equal(
      toRoom({ ...brut, uids: ['moi-uid'] }, 'alice', 'moi-uid')?.dmOtherUid,
      'moi-uid',
    );
    // DM de GROUPE (3+) : pas UNE présence à montrer.
    assert.equal(
      toRoom({ ...brut, uids: ['moi-uid', 'lui-uid', 'eux-uid'] }, 'alice', 'moi-uid')
        ?.dmOtherUid,
      null,
    );
    // Sans moiUid (vieux appelants) : null, pas de devinette.
    assert.equal(toRoom(brut, 'alice')?.dmOtherUid, null);
    // Un canal n'en a jamais.
    assert.equal(toRoom({ ...brut, t: 'c' }, 'alice', 'moi-uid')?.dmOtherUid, null);
  });

  test('extrait AUSSI son pseudo — sans lui, l’avatar d’un DM jamais ouvert reste figé', () => {
    // Vécu sur l'émulateur : la liste affiche l'avatar d'alice alors qu'aucun de
    // ses messages n'est ingéré. `updateAvatar` ne désignant l'utilisateur que
    // par son pseudo, il ne trouvait AUCUNE ligne à mettre à jour.
    const brut = { _id: 'r1', t: 'd', uids: ['moi-uid', 'lui-uid'], usernames: ['alice', 'bob'] };
    assert.equal(toRoom(brut, 'alice', 'moi-uid')?.dmOtherUsername, 'bob');
    // DM avec soi-même : l'autre, c'est moi — des deux côtés.
    assert.equal(
      toRoom({ ...brut, uids: ['moi-uid'], usernames: ['alice'] }, 'alice', 'moi-uid')
        ?.dmOtherUsername,
      'alice',
    );
    // Pas de pseudo sans uid apparié : on n'invente pas d'identité.
    assert.equal(toRoom({ ...brut, uids: undefined }, 'alice', 'moi-uid')?.dmOtherUsername, null);
    assert.equal(toRoom({ ...brut, usernames: undefined }, 'alice', 'moi-uid')?.dmOtherUsername, null);
  });
});

describe('versAbonnement', () => {
  test('les compteurs absents valent 0, pas NaN', () => {
    const a = toSubscription({ rid: 'r1' }) as LocalSubscription;
    assert.equal(a.unread, 0);
    assert.equal(a.mentions, 0);
    assert.equal(a.favorite, false);
    assert.equal(a.lastSeen, null);
  });
});

/** Dépôt en mémoire : on observe ce que le moteur décide d'écrire. */
function faireDepot() {
  const messages: MessageLocal[] = [];
  const salons: LocalRoom[] = [];
  const abonnements: LocalSubscription[] = [];
  const supprimes: string[] = [];
  const supprimesSalons: string[] = [];
  const supprimesParSubId: string[] = [];
  const curseurs = new Map<string, number>();
  /** Versions d'avatar écrites, clé `u:<pseudo>` ou `r:<rid>`. */
  const avatars = new Map<string, string>();
  const identites: { uid: string; username: string; avatarEtag: string | null }[] = [];
  // Le piège rejoue l'invariant de `db/store.ts` : pendant une transaction,
  // seules les écritures du `tx` reçu passent — celles du dépôt jettent.
  const depot: Store = withTransactionTrap({
    upsertMessage: async (m) => void messages.push(m),
    upsertRoom: async (s) => void salons.push(s),
    upsertSubscription: async (a) => void abonnements.push(a),
    deleteMessage: async (id) => void supprimes.push(id),
    deleteRoom: async (rid) => void supprimesSalons.push(rid),
    deleteSubscription: async () => {},
    deleteBySubId: async (subId) => void supprimesParSubId.push(subId),
    listKnownRids: async () => [],
    purgeMissingRooms: async () => {},
    applyRetention: async () => {},
    readCursor: async (p, f) => curseurs.get(`${p}|${f}`) ?? null,
    writeCursor: async (p, f, v) => void curseurs.set(`${p}|${f}`, v),
    lastMessageUpdatedAt: async () => null,
    listRoomKeys: async () =>
      abonnements
        .filter((a): a is LocalSubscription & { e2eKey: string } => a.e2eKey !== null)
        .map((a) => ({ rid: a.rid, e2eKey: a.e2eKey })),
    messagesToDecrypt: async () =>
      messages
        .filter((m): m is MessageLocal & { encryptedRaw: string } => m.encryptedRaw !== null && m.text === null)
        .map((m) => ({ id: m.id, rid: m.rid, encryptedRaw: m.encryptedRaw })),
    updateMessageText: async (id, texte, piecesJointes) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { text: texte, attachments: piecesJointes ?? m.attachments });
    },
    updateMessageMarks: async (id, epingle, etoiles) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) Object.assign(m, { pinned: epingle, starred: etoiles });
    },
    hideEncryptedMessages: async () => {
      for (const m of messages) if (m.encryptedRaw !== null) Object.assign(m, { text: null, attachments: null });
    },
    updateEncryptedPreview: async () => {},
    updateUserAvatar: async (username, etag) => void avatars.set(`u:${username}`, etag),
    updateRoomAvatar: async (rid, etag) => void avatars.set(`r:${rid}`, etag),
    saveIdentity: async (i) => void identites.push(i),
  });
  return {
    depot,
    messages,
    salons,
    abonnements,
    supprimes,
    supprimesSalons,
    supprimesParSubId,
    avatars,
    identites,
  };
}

const evenement = (collection: string, cleEvenement: string, args: unknown[]): DdpEvent => ({
  collection,
  eventKey: cleEvenement,
  args,
});

describe('MoteurSynchro', () => {
  test('un message du stream est écrit', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-room-messages', 'r1', [
        { _id: 'm1', rid: 'r1', msg: 'salut', ts: { $date: 1 }, u: { _id: 'u1' } },
      ]),
    );
    assert.equal(messages.length, 1);
    assert.equal(moteur.stats.messages, 1);
  });

  test('`subscriptions-changed` livre [action, document] : le document est le SECOND argument', async () => {
    // Relevé contre un serveur 8.5 : args[0] vaut la chaîne « updated ».
    // Traiter args[0] comme le document ferait disparaître en silence tous les
    // changements d'abonnement — donc tous les compteurs de non-lus.
    const { depot, abonnements } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-notify-user', 'u1/subscriptions-changed', [
        'updated',
        { rid: 'r1', unread: 3, _updatedAt: { $date: 7 } },
      ]),
    );
    assert.equal(abonnements.length, 1);
    assert.equal(abonnements[0].unread, 3);
    assert.equal(moteur.stats.ignores, 0);
  });

  test('la forme sans action est acceptée aussi', async () => {
    const { depot, abonnements } = faireDepot();
    await new SyncEngine(depot, new RcTranslator()).apply(
      evenement('stream-notify-user', 'u1/subscriptions-changed', [{ rid: 'r1', unread: 1 }]),
    );
    assert.equal(abonnements.length, 1);
  });

  test('`rooms-changed` écrit un salon', async () => {
    const { depot, salons } = faireDepot();
    await new SyncEngine(depot, new RcTranslator()).apply(
      evenement('stream-notify-user', 'u1/rooms-changed', ['updated', { _id: 'r1', t: 'c' }]),
    );
    assert.equal(salons.length, 1);
  });

  test('`subscriptions-changed` action "removed" supprime par subId — fin du fantôme', async () => {
    // Le bug historique : l'action 'removed' était consommée puis IGNORÉE, et
    // le document (juste { _id }) tentait un upsert. Un salon supprimé côté
    // serveur restait donc en cache à vie. Ici on vérifie la suppression.
    const { depot, supprimesParSubId, abonnements } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-notify-user', 'u1/subscriptions-changed', ['removed', { _id: 'sub1' }]),
    );
    assert.deepEqual(supprimesParSubId, ['sub1']);
    assert.equal(abonnements.length, 0, 'aucun upsert : le salon ne ressuscite pas');
    assert.equal(moteur.stats.deletions, 1);
  });

  test('`rooms-changed` action "removed" supprime le salon', async () => {
    const { depot, supprimesSalons, salons } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-notify-user', 'u1/rooms-changed', ['removed', { _id: 'r1' }]),
    );
    assert.deepEqual(supprimesSalons, ['r1']);
    assert.equal(salons.length, 0);
    assert.equal(moteur.stats.deletions, 1);
  });

  test('`deleteMessage` supprime', async () => {
    const { depot, supprimes } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(evenement('stream-notify-room', 'r1/deleteMessage', [{ _id: 'm1' }]));
    assert.deepEqual(supprimes, ['m1']);
    assert.equal(moteur.stats.deletions, 1);
  });

  test('`updateAvatar` pose la version de la photo d’un utilisateur, par PSEUDO', async () => {
    // Le stream ne désigne jamais l'utilisateur par son uid (relevé sur 8.5) :
    // c'est ce qui impose d'indexer les versions par pseudo AUSSI.
    const { depot, avatars } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-notify-logged', 'updateAvatar', [{ username: 'bob', etag: 'e1' }]),
    );
    assert.equal(avatars.get('u:bob'), 'e1');
    assert.equal(moteur.stats.ignores, 0, 'un avatar n’est pas une anomalie');
  });

  test('`updateAvatar` d’un SALON vise le rid', async () => {
    const { depot, avatars } = faireDepot();
    await new SyncEngine(depot, new RcTranslator()).apply(
      evenement('stream-notify-logged', 'updateAvatar', [{ rid: 'r1', etag: 'e2' }]),
    );
    assert.equal(avatars.get('r:r1'), 'e2');
  });

  test('une photo RETIRÉE (etag absent) pose quand même un marqueur', async () => {
    // `users.resetAvatar` n'envoie pas d'etag. Sans marqueur, l'URL retomberait
    // sur sa forme d'avant — celle que le cache image sert avec l'ANCIENNE
    // photo : l'avatar supprimé resterait affiché.
    const { depot, avatars } = faireDepot();
    await new SyncEngine(depot, new RcTranslator()).apply(
      evenement('stream-notify-logged', 'updateAvatar', [{ username: 'bob' }]),
    );
    assert.equal(avatars.get('u:bob'), AVATAR_NO_PHOTO);
  });

  test('la présence transite par le même stream mais n’est PAS une anomalie', async () => {
    const { depot } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(
      evenement('stream-notify-logged', 'user-status', [['u1', 'alice', 1, '']]),
    );
    assert.equal(moteur.stats.ignores, 0, 'sinon chaque aller-retour gonfle le compteur');
  });

  test('un stream inconnu est ignoré, mais compté', async () => {
    const { depot } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(evenement('stream-livechat-inquiry', 'x', [{}]));
    await moteur.apply(evenement('stream-notify-user', 'u1/webrtc', ['updated', {}]));
    assert.equal(moteur.stats.ignores, 2, 'ignoré ne veut pas dire invisible');
  });

  test('une charge utile malformée n’interrompt pas le flux', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.apply(evenement('stream-room-messages', 'r1', ['pas un objet']));
    await moteur.apply(evenement('stream-room-messages', 'r1', [{ _id: 'sans-rid' }]));
    assert.equal(messages.length, 0);
    assert.equal(moteur.stats.ignores, 2);
  });

  test('un lot REST passe par les mêmes upserts que le WebSocket', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator());
    await moteur.ingestMessages([
      { _id: 'm1', rid: 'r1', msg: 'a', ts: { $date: 1 }, u: { _id: 'u1' } },
      { _id: 'm2', rid: 'r1', msg: 'b', ts: { $date: 2 }, u: { _id: 'u1' } },
      { pas: 'un message' },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(moteur.stats.ignores, 1);
  });
});

/** Message chiffré `rc.v2.aes-sha2` : ciphertext dans `content`, `msg` vide. */
const msgChiffre = (id: string, ct: string): Record<string, unknown> => ({
  _id: id,
  rid: 'r1',
  t: 'e2e',
  msg: '',
  ts: { $date: 1 },
  u: { _id: 'u1' },
  content: { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'iv', ciphertext: ct },
  _updatedAt: 1,
});

describe('MoteurSynchro — déchiffrement E2EE', () => {
  test('déchiffre à l’ingestion quand la clé est disponible', async () => {
    const { depot, messages } = faireDepot();
    const dechiffreur: E2EDecryptor = {
      decryptContent: (_rid, content) =>
        content.ciphertext === 'CT' ? { text: 'clair !', attachments: null } : null,
      saveRoomKey: () => {},
    };
    const moteur = new SyncEngine(depot, new RcTranslator('moi', 'uid'), dechiffreur);
    await moteur.ingestMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].text, 'clair !');
    assert.notEqual(messages[0].encryptedRaw, null); // ciphertext gardé
  });

  test('verrouillé : reste illisible, puis la passe de déverrouillage l’éclaire', async () => {
    const { depot, messages } = faireDepot();
    let deverrouille = false;
    const dechiffreur: E2EDecryptor = {
      decryptContent: (_rid, content) =>
        deverrouille && content.ciphertext === 'CT' ? { text: 'clair !', attachments: null } : null,
      saveRoomKey: () => {},
    };
    const moteur = new SyncEngine(depot, new RcTranslator('moi', 'uid'), dechiffreur);
    await moteur.ingestMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].text, null); // verrouillé → placeholder

    deverrouille = true;
    const n = await moteur.e2eUnlocked();
    assert.equal(n, 1);
    assert.equal(messages[0].text, 'clair !');
  });

  test('un fichier chiffré : ses pièces jointes viennent du clair, à l’ingestion comme au déverrouillage', async () => {
    const jointes = JSON.stringify([{ title: 'photo.jpg', encryption: { iv: 'aXY=' } }]);
    const { depot, messages } = faireDepot();
    let deverrouille = false;
    const dechiffreur: E2EDecryptor = {
      decryptContent: () => (deverrouille ? { text: '', attachments: jointes } : null),
      saveRoomKey: () => {},
    };
    const moteur = new SyncEngine(depot, new RcTranslator('moi', 'uid'), dechiffreur);
    await moteur.ingestMessages([{ ...msgChiffre('m1', 'CT'), attachments: [{ title: 'haché.bin' }] }]);
    assert.equal(messages[0].attachments, null, 'jamais celles du serveur, opaques');

    deverrouille = true;
    await moteur.e2eUnlocked();
    assert.equal(messages[0].attachments, jointes);

    await moteur.ingestMessages([msgChiffre('m2', 'CT')]);
    assert.equal(messages[1].attachments, jointes);
  });

  test('sans déchiffreur, un message chiffré garde son ciphertext et reste illisible', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new SyncEngine(depot, new RcTranslator('moi', 'uid')); // pas de déchiffreur
    await moteur.ingestMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].text, null);
    assert.notEqual(messages[0].encryptedRaw, null);
    assert.equal(await moteur.e2eUnlocked(), 0);
  });
});
