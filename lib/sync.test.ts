import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Evenement } from './ddp.ts';
import {
  versAbonnement,
  versEpoch,
  versMessage,
  versSalon,
  type AbonnementLocal,
  type MessageLocal,
  type SalonLocal,
} from './normaliser.ts';
import { MoteurSynchro, type DechiffreurE2E, type Depot } from './sync.ts';

describe('versEpoch', () => {
  test('accepte l’EJSON de Rocket.Chat', () => {
    assert.equal(versEpoch({ $date: 1_700_000_000_000 }), 1_700_000_000_000);
  });
  test('accepte une chaîne ISO', () => {
    assert.equal(versEpoch('2026-07-10T00:00:00.000Z'), Date.parse('2026-07-10T00:00:00.000Z'));
  });
  test('accepte un nombre brut', () => {
    assert.equal(versEpoch(42), 42);
  });
  test('rend null sur ce qu’il ne comprend pas, plutôt que NaN', () => {
    assert.equal(versEpoch(undefined), null);
    assert.equal(versEpoch('pas une date'), null);
    assert.equal(versEpoch({}), null);
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
    const m = versMessage(base) as MessageLocal;
    assert.equal(m.id, 'm1');
    assert.equal(m.texte, 'bonjour');
    assert.equal(m.horodatage, 1000);
    assert.equal(m.misAJourLe, 2000);
    assert.equal(m.auteurNom, 'alice');
    assert.equal(m.typeSysteme, null);
  });

  test('un message chiffré ne stocke JAMAIS son contenu', () => {
    const m = versMessage({ ...base, t: 'e2e', msg: 'blob-base64-opaque' }) as MessageLocal;
    assert.equal(m.typeSysteme, 'e2e');
    assert.equal(m.texte, null, 'le blob ne doit pas atteindre la base');
    assert.equal(m.md, null);
    assert.equal(m.piecesJointes, null);
  });

  test('`_updatedAt` absent retombe sur l’horodatage du message', () => {
    const { _updatedAt, ...sans } = base;
    void _updatedAt;
    const m = versMessage(sans) as MessageLocal;
    assert.equal(m.misAJourLe, 1000);
  });

  test('un document sans `_id`, `rid`, `ts` ou auteur est rejeté', () => {
    assert.equal(versMessage({ ...base, _id: undefined }), null);
    assert.equal(versMessage({ ...base, rid: undefined }), null);
    assert.equal(versMessage({ ...base, ts: undefined }), null);
    assert.equal(versMessage({ ...base, u: {} }), null);
  });

  test('`md` et `attachments` sont sérialisés, `undefined` devient null', () => {
    const m = versMessage({ ...base, md: [{ type: 'PARAGRAPH' }] }) as MessageLocal;
    assert.equal(m.md, '[{"type":"PARAGRAPH"}]');
    assert.equal(m.piecesJointes, null);
  });

  test('`urls` (métadonnées de lien serveur) est sérialisé ; absent → null', () => {
    const avec = versMessage({ ...base, urls: [{ url: 'https://x', meta: { ogTitle: 'T' } }] }) as MessageLocal;
    assert.equal(avec.urls, '[{"url":"https://x","meta":{"ogTitle":"T"}}]');
    assert.equal((versMessage(base) as MessageLocal).urls, null);
    // Un salon chiffré ne stocke jamais d'aperçu.
    assert.equal((versMessage({ ...base, t: 'e2e', urls: [{ url: 'https://x' }] }) as MessageLocal).urls, null);
  });

  test('fils : `tmid`, `tcount`, `tlm` et `tshow` sont capturés (8.3)', () => {
    const racine = versMessage({
      ...base,
      tcount: 3,
      tlm: { $date: 5000 },
    }) as MessageLocal;
    assert.equal(racine.filReponses, 3);
    assert.equal(racine.filDernier, 5000);
    assert.equal(racine.filId, null);
    assert.equal(racine.filAffiche, false);

    const reponse = versMessage({ ...base, _id: 'm2', tmid: 'm1', tshow: true }) as MessageLocal;
    assert.equal(reponse.filId, 'm1');
    assert.equal(reponse.filAffiche, true, 'tshow = aussi visible dans le flux principal');
  });
});

describe('versSalon', () => {
  test('un salon chiffré n’expose pas d’aperçu', () => {
    const s = versSalon({
      _id: 'r1',
      t: 'p',
      name: 'laprivitude',
      encrypted: true,
      lastMessage: { msg: 'ciphertext', ts: { $date: 5 } },
      _updatedAt: { $date: 9 },
    }) as SalonLocal;
    assert.equal(s.chiffre, true);
    assert.equal(s.dernierMessage, null, "l'aperçu d'un salon chiffré est du ciphertext");
    assert.equal(s.horodatageDernierMessage, 5, 'mais son horodatage sert au tri');
  });

  test('`fname` prime sur `name` pour l’affichage', () => {
    const s = versSalon({ _id: 'r1', t: 'c', name: 'slug', fname: 'Nom Affiché' }) as SalonLocal;
    assert.equal(s.nomAffiche, 'Nom Affiché');
    assert.equal(s.nom, 'slug');
  });

  test('sans `fname`, on retombe sur `name`', () => {
    const s = versSalon({ _id: 'r1', t: 'c', name: 'slug' }) as SalonLocal;
    assert.equal(s.nomAffiche, 'slug');
  });

  test('un DM sans nom se nomme depuis `usernames`, en s’excluant soi-même', () => {
    // `rooms.get` renvoie les DM sans `name` ni `fname` : seul `usernames`
    // permet de les nommer, et il contient AUSSI l'utilisateur courant.
    const s = versSalon({ _id: 'r1', t: 'd', usernames: ['alice', 'bob'] }, 'alice') as SalonLocal;
    assert.equal(s.nomAffiche, 'bob');
  });

  test('un DM avec soi-même garde son propre nom', () => {
    const s = versSalon({ _id: 'r1', t: 'd', usernames: ['alice'] }, 'alice') as SalonLocal;
    assert.equal(s.nomAffiche, 'alice');
  });

  test('un DM de groupe joint les autres participants', () => {
    const s = versSalon(
      { _id: 'r1', t: 'd', usernames: ['alice', 'bob', 'carol'] },
      'alice',
    ) as SalonLocal;
    assert.equal(s.nomAffiche, 'bob, carol');
  });
});

describe('versSalon — dmAutreUid (8.4)', () => {
  test('extrait l’autre uid d’un DM à deux ; jamais pour un groupe ou sans moiUid', () => {
    const brut = { _id: 'r1', t: 'd', uids: ['moi-uid', 'lui-uid'], usernames: ['alice', 'bob'] };
    assert.equal(versSalon(brut, 'alice', 'moi-uid')?.dmAutreUid, 'lui-uid');
    // DM avec soi-même : l'autre, c'est moi.
    assert.equal(
      versSalon({ ...brut, uids: ['moi-uid'] }, 'alice', 'moi-uid')?.dmAutreUid,
      'moi-uid',
    );
    // DM de GROUPE (3+) : pas UNE présence à montrer.
    assert.equal(
      versSalon({ ...brut, uids: ['moi-uid', 'lui-uid', 'eux-uid'] }, 'alice', 'moi-uid')
        ?.dmAutreUid,
      null,
    );
    // Sans moiUid (vieux appelants) : null, pas de devinette.
    assert.equal(versSalon(brut, 'alice')?.dmAutreUid, null);
    // Un canal n'en a jamais.
    assert.equal(versSalon({ ...brut, t: 'c' }, 'alice', 'moi-uid')?.dmAutreUid, null);
  });
});

describe('versAbonnement', () => {
  test('les compteurs absents valent 0, pas NaN', () => {
    const a = versAbonnement({ rid: 'r1' }) as AbonnementLocal;
    assert.equal(a.nonLus, 0);
    assert.equal(a.mentions, 0);
    assert.equal(a.favori, false);
    assert.equal(a.luJusquA, null);
  });
});

/** Dépôt en mémoire : on observe ce que le moteur décide d'écrire. */
function faireDepot() {
  const messages: MessageLocal[] = [];
  const salons: SalonLocal[] = [];
  const abonnements: AbonnementLocal[] = [];
  const supprimes: string[] = [];
  const supprimesSalons: string[] = [];
  const supprimesParSubId: string[] = [];
  const curseurs = new Map<string, number>();
  const depot: Depot = {
    upsertMessage: async (m) => void messages.push(m),
    upsertSalon: async (s) => void salons.push(s),
    upsertAbonnement: async (a) => void abonnements.push(a),
    supprimerMessage: async (id) => void supprimes.push(id),
    supprimerSalon: async (rid) => void supprimesSalons.push(rid),
    supprimerAbonnement: async () => {},
    supprimerParSubId: async (subId) => void supprimesParSubId.push(subId),
    purgerSalonsAbsents: async () => {},
    lireCurseur: async (p, f) => curseurs.get(`${p}|${f}`) ?? null,
    ecrireCurseur: async (p, f, v) => void curseurs.set(`${p}|${f}`, v),
    dernierMessageMisAJour: async () => null,
    listerClesSalon: async () =>
      abonnements
        .filter((a): a is AbonnementLocal & { e2eKey: string } => a.e2eKey !== null)
        .map((a) => ({ rid: a.rid, e2eKey: a.e2eKey })),
    messagesADechiffrer: async () =>
      messages
        .filter((m): m is MessageLocal & { chiffreBrut: string } => m.chiffreBrut !== null && m.texte === null)
        .map((m) => ({ id: m.id, rid: m.rid, chiffreBrut: m.chiffreBrut })),
    majTexteMessage: async (id, texte) => {
      const m = messages.find((x) => x.id === id);
      if (m !== undefined) m.texte = texte;
    },
    masquerMessagesChiffres: async () => {
      for (const m of messages) if (m.chiffreBrut !== null) m.texte = null;
    },
    transaction: async (fn) => fn(depot),
  };
  return { depot, messages, salons, abonnements, supprimes, supprimesSalons, supprimesParSubId };
}

const evenement = (collection: string, cleEvenement: string, args: unknown[]): Evenement => ({
  collection,
  cleEvenement,
  args,
});

describe('MoteurSynchro', () => {
  test('un message du stream est écrit', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(
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
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(
      evenement('stream-notify-user', 'u1/subscriptions-changed', [
        'updated',
        { rid: 'r1', unread: 3, _updatedAt: { $date: 7 } },
      ]),
    );
    assert.equal(abonnements.length, 1);
    assert.equal(abonnements[0].nonLus, 3);
    assert.equal(moteur.stats.ignores, 0);
  });

  test('la forme sans action est acceptée aussi', async () => {
    const { depot, abonnements } = faireDepot();
    await new MoteurSynchro(depot).appliquer(
      evenement('stream-notify-user', 'u1/subscriptions-changed', [{ rid: 'r1', unread: 1 }]),
    );
    assert.equal(abonnements.length, 1);
  });

  test('`rooms-changed` écrit un salon', async () => {
    const { depot, salons } = faireDepot();
    await new MoteurSynchro(depot).appliquer(
      evenement('stream-notify-user', 'u1/rooms-changed', ['updated', { _id: 'r1', t: 'c' }]),
    );
    assert.equal(salons.length, 1);
  });

  test('`subscriptions-changed` action "removed" supprime par subId — fin du fantôme', async () => {
    // Le bug historique : l'action 'removed' était consommée puis IGNORÉE, et
    // le document (juste { _id }) tentait un upsert. Un salon supprimé côté
    // serveur restait donc en cache à vie. Ici on vérifie la suppression.
    const { depot, supprimesParSubId, abonnements } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(
      evenement('stream-notify-user', 'u1/subscriptions-changed', ['removed', { _id: 'sub1' }]),
    );
    assert.deepEqual(supprimesParSubId, ['sub1']);
    assert.equal(abonnements.length, 0, 'aucun upsert : le salon ne ressuscite pas');
    assert.equal(moteur.stats.suppressions, 1);
  });

  test('`rooms-changed` action "removed" supprime le salon', async () => {
    const { depot, supprimesSalons, salons } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(
      evenement('stream-notify-user', 'u1/rooms-changed', ['removed', { _id: 'r1' }]),
    );
    assert.deepEqual(supprimesSalons, ['r1']);
    assert.equal(salons.length, 0);
    assert.equal(moteur.stats.suppressions, 1);
  });

  test('`deleteMessage` supprime', async () => {
    const { depot, supprimes } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(evenement('stream-notify-room', 'r1/deleteMessage', [{ _id: 'm1' }]));
    assert.deepEqual(supprimes, ['m1']);
    assert.equal(moteur.stats.suppressions, 1);
  });

  test('un stream inconnu est ignoré, mais compté', async () => {
    const { depot } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(evenement('stream-livechat-inquiry', 'x', [{}]));
    await moteur.appliquer(evenement('stream-notify-user', 'u1/webrtc', ['updated', {}]));
    assert.equal(moteur.stats.ignores, 2, 'ignoré ne veut pas dire invisible');
  });

  test('une charge utile malformée n’interrompt pas le flux', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.appliquer(evenement('stream-room-messages', 'r1', ['pas un objet']));
    await moteur.appliquer(evenement('stream-room-messages', 'r1', [{ _id: 'sans-rid' }]));
    assert.equal(messages.length, 0);
    assert.equal(moteur.stats.ignores, 2);
  });

  test('un lot REST passe par les mêmes upserts que le WebSocket', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new MoteurSynchro(depot);
    await moteur.ingererMessages([
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
    const dechiffreur: DechiffreurE2E = {
      dechiffrerContenu: (_rid, content) => (content.ciphertext === 'CT' ? 'clair !' : null),
      enregistrerCleSalon: () => {},
    };
    const moteur = new MoteurSynchro(depot, 'moi', 'uid', dechiffreur);
    await moteur.ingererMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].texte, 'clair !');
    assert.notEqual(messages[0].chiffreBrut, null); // ciphertext gardé
  });

  test('verrouillé : reste illisible, puis la passe de déverrouillage l’éclaire', async () => {
    const { depot, messages } = faireDepot();
    let deverrouille = false;
    const dechiffreur: DechiffreurE2E = {
      dechiffrerContenu: (_rid, content) =>
        deverrouille && content.ciphertext === 'CT' ? 'clair !' : null,
      enregistrerCleSalon: () => {},
    };
    const moteur = new MoteurSynchro(depot, 'moi', 'uid', dechiffreur);
    await moteur.ingererMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].texte, null); // verrouillé → placeholder

    deverrouille = true;
    const n = await moteur.deverrouillageE2E();
    assert.equal(n, 1);
    assert.equal(messages[0].texte, 'clair !');
  });

  test('sans déchiffreur, un message chiffré garde son ciphertext et reste illisible', async () => {
    const { depot, messages } = faireDepot();
    const moteur = new MoteurSynchro(depot, 'moi', 'uid'); // pas de déchiffreur
    await moteur.ingererMessages([msgChiffre('m1', 'CT')]);
    assert.equal(messages[0].texte, null);
    assert.notEqual(messages[0].chiffreBrut, null);
    assert.equal(await moteur.deverrouillageE2E(), 0);
  });
});
