import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withTransactionTrap } from './testStore.ts';
import { catchUpGlobal, catchUpRoom, reconcileRooms } from './catchUp.ts';
import { ClientRest } from './rest.ts';
import { SyncEngine, type Store } from './sync.ts';
import { RcTranslator } from '../providers/rocketchat/translator.ts';

function fullFakeStore() {
  const cursors = new Map<string, number>();
  const deletedRooms: string[] = [];
  const deletedSubscriptions: string[] = [];
  const deletedMessages: string[] = [];
  const rooms: string[] = [];
  const subscriptions: string[] = [];
  const messages: string[] = [];
  const deletedBySubId: string[] = [];
  const purges: { alive: string[]; known: string[] }[] = [];
  const identities: { uid: string; username: string; avatarEtag: string | null }[] = [];
  const retentions: number[] = [];
  /** Les rids « déjà en base », mutables : le stream écrit pendant le vol. */
  const known: string[] = [];
  let lastLocal: number | null = null;
  // Le piège rejoue l'invariant de `db/store.ts` : pendant une transaction,
  // seules les écritures du `tx` reçu passent — celles du dépôt jettent.
  const store: Store = withTransactionTrap({
    upsertMessage: async (m) => void messages.push(m.id),
    upsertRoom: async (s) => void rooms.push(s.rid),
    upsertSubscription: async (a) => void subscriptions.push(a.rid),
    deleteMessage: async (id) => void deletedMessages.push(id),
    deleteRoom: async (rid) => void deletedRooms.push(rid),
    deleteSubscription: async (rid) => void deletedSubscriptions.push(rid),
    deleteBySubId: async (subId) => void deletedBySubId.push(subId),
    listKnownRids: async () => [...known],
    purgeMissingRooms: async (alive, conn) => void purges.push({ alive, known: conn }),
    applyRetention: async (n) => void retentions.push(n),
    readCursor: async (scope, stream) => cursors.get(`${scope}|${stream}`) ?? null,
    writeCursor: async (scope, stream, value) => {
      const key = `${scope}|${stream}`;
      const current = cursors.get(key);
      if (current === undefined || value > current) cursors.set(key, value);
    },
    lastMessageUpdatedAt: async () => lastLocal,
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => {},
    updateMessageMarks: async () => {},
    hideEncryptedMessages: async () => {},
    updateEncryptedPreview: async () => {},
    updateUserAvatar: async () => {},
    updateRoomAvatar: async () => {},
    saveIdentity: async (i) => void identities.push(i),
  });
  return {
    store,
    cursors,
    identities,
    salons: rooms,
    abonnements: subscriptions,
    messages,
    deletedRooms,
    deletedSubscriptions,
    deletedMessages,
    deletedBySubId,
    purges,
    retentions,
    known,
    setLastLocal: (v: number | null) => {
      lastLocal = v;
    },
  };
}

/**
 * Client réel, fetch simulé : on vérifie les VRAIS paramètres d'URL.
 * `pendantLeVol` joue au moment où le serveur répond — c'est là que le stream
 * DDP écrit, dans le dos de la réponse qu'on est en train de recevoir.
 */
function fakeClient(responses: Record<string, unknown>, duringFlight?: (path: string) => void) {
  const urls: string[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      const u = String(url);
      urls.push(u);
      const path = new URL(u).pathname.split('/api/v1/')[1];
      duringFlight?.(path ?? '');
      return new Response(JSON.stringify(responses[path] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

describe('rattraperGlobal', () => {
  test('sans curseur : chargement complet (pas d’updatedSince), puis curseurs posés', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      'rooms.get': {
        update: [{ _id: 'r1', t: 'c', _updatedAt: { $date: 500 } }],
        remove: [],
      },
      'subscriptions.get': {
        update: [{ rid: 'r1', _updatedAt: { $date: 700 } }],
        remove: [],
      },
    });

    await catchUpGlobal(client, engine);

    assert.ok(!urls.some((u) => u.includes('updatedSince')), 'premier passage = complet');
    assert.deepEqual(d.salons, ['r1']);
    assert.equal(d.cursors.get('*|salons'), 500, 'curseur = plus grand _updatedAt INGÉRÉ');
    assert.equal(d.cursors.get('*|abonnements'), 700);
  });

  test('avec curseur : updatedSince est envoyé, les remove font le ménage', async () => {
    const d = fullFakeStore();
    d.cursors.set('*|salons', 1000);
    d.cursors.set('*|abonnements', 1000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      // Projections réelles du serveur 8.5 : `remove[]` de rooms.get porte le
      // `_id` du SALON supprimé ; celui de subscriptions.get porte le `_id`
      // de l'ABONNEMENT (jamais le rid).
      'rooms.get': { update: [], remove: [{ _id: 'r-detruit' }] },
      'subscriptions.get': { update: [], remove: [{ _id: 'sub-quitte' }] },
    });

    await catchUpGlobal(client, engine);

    const roomsUrl = urls.find((u) => u.includes('rooms.get'));
    assert.ok(
      roomsUrl?.includes(`updatedSince=${encodeURIComponent(new Date(1000).toISOString())}`),
      'le delta part du curseur',
    );
    assert.deepEqual(d.deletedRooms, ['r-detruit']);
    assert.deepEqual(d.deletedBySubId, ['sub-quitte']);
    assert.equal(d.cursors.get('*|salons'), 1000, 'rien d’ingéré : le curseur ne bouge pas');
  });

  test('MA version d’avatar est rattrapée par `me` — le seul chemin après une app fermée', async () => {
    // Photo changée depuis un autre client pendant que l'app dormait : aucun
    // stream ne l'a annoncé. Sans cette lecture, l'ancienne photo resterait
    // affichée jusqu'au prochain changement.
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({
      'rooms.get': { update: [], remove: [] },
      'subscriptions.get': { update: [], remove: [] },
      me: { _id: 'u1', username: 'alice', avatarETag: 'etag-frais' },
    });

    await catchUpGlobal(client, engine);

    assert.deepEqual(d.identities, [{ uid: 'u1', username: 'alice', avatarEtag: 'etag-frais' }]);
  });

  test('un `me` en échec ne fait pas échouer le rattrapage', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        const path = new URL(String(url)).pathname.split('/api/v1/')[1];
        if (path === 'me') throw new Error('réseau coupé');
        return new Response(JSON.stringify({ update: [{ _id: 'r1', t: 'c' }], remove: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });

    await catchUpGlobal(client, engine);

    assert.deepEqual(d.salons, ['r1'], 'les salons passent quand même');
    assert.equal(d.identities.length, 0);
  });
});

/** Réponses servies DANS L'ORDRE — c'est ce qui permet de tester la pagination. */
function clientSequence(responses: (Record<string, unknown> | number)[]) {
  const urls: string[] = [];
  let i = 0;
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const status = typeof r === 'number' ? r : 200;
      const body = typeof r === 'number' ? { success: false, error: 'params' } : r;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

/** Une page en mode curseur, telle que le serveur 8.5 la rend. */
const page = (updated: unknown[], next: string | null, deleted: unknown[] = []) => ({
  result: { updated, deleted, cursor: { next, previous: '0' } },
});

const msg = (id: string, update: number) => ({
  _id: id,
  rid: 'r1',
  msg: id,
  ts: { $date: update },
  u: { _id: 'u1' },
  _updatedAt: { $date: update },
});

describe('rattraperSalon', () => {
  test('sans curseur : ne fait RIEN — repartir de l’origine re-téléchargerait tout', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({});
    await catchUpRoom(client, engine, 'r1');
    assert.equal(urls.length, 0);
  });

  test('mode curseur : type/next/count, et SURTOUT pas de lastUpdate', async () => {
    // `lastUpdate`, s'il est présent, GAGNE sur `type`/`next` : la réponse
    // retombe en mode non borné (1,85 Mo mesurés). Son absence est le cœur du
    // correctif, pas un détail de forme.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 2000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([msg('m1', 2600)], null)]);

    await catchUpRoom(client, engine, 'r1');

    assert.ok(urls[0]?.includes('chat.syncMessages'));
    assert.ok(urls[0]?.includes('roomId=r1'));
    assert.ok(urls[0]?.includes('type=UPDATED'));
    assert.ok(urls[0]?.includes('next=2000'));
    assert.ok(urls[0]?.includes('count=50'));
    assert.ok(!urls[0]?.includes('lastUpdate'), `lastUpdate doit être absent, vu ${urls[0]}`);
    assert.deepEqual(d.messages, ['m1']);
  });

  test('le curseur avance APRÈS CHAQUE page, dernière comprise', async () => {
    // C'est ce qui rend le plafonnement sûr : interrompu à n'importe quelle
    // page, le passage suivant reprend là où on s'est arrêté.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-supprimes', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const seen: (number | undefined)[] = [];
    const { client } = clientSequence([page([msg('m1', 1500)], '2000'), page([msg('m2', 2500)], null)]);
    const write = d.store.writeCursor.bind(d.store);
    d.store.writeCursor = async (scope, stream, v) => {
      if (stream === 'messages') seen.push(v);
      await write(scope, stream, v);
    };

    await catchUpRoom(client, engine, 'r1');

    // Page 1 : le curseur du SERVEUR (2000), pas le plus grand `_updatedAt`
    // ingéré (1500) — lui seul reprend la pagination, groupes d'ex æquo compris.
    // Page 2 : `next: null`, il n'y a plus de curseur serveur à recopier, on
    // avance donc sur ce qu'on a ingéré (2500).
    assert.deepEqual(seen, [2000, 2500]);
    assert.deepEqual(d.messages, ['m1', 'm2']);
  });

  test('deux ouvertures d’affilée : la seconde ne redemande PAS la même tranche', async () => {
    // Le symptôme vécu : sortir d'un salon et y rentrer aussitôt relançait un
    // rattrapage de plusieurs secondes. Le serveur rend `cursor.next = null` dès
    // qu'il ne reste rien après la page — donc le cas NOMINAL, un retard qui
    // tient en une page, n'avait aucun curseur serveur à recopier. Le curseur
    // restait figé à vie, la tranche était redemandée à chaque ouverture, et
    // elle grossissait à chaque message posté depuis.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-supprimes', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([msg('m1', 1500)], null)]);

    await catchUpRoom(client, engine, 'r1');
    await catchUpRoom(client, engine, 'r1');

    const updates = urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'une requête par ouverture');
    assert.ok(updates[0]?.includes('next=1000'));
    assert.ok(updates[1]?.includes('next=1500'), `la 2e ouverture repart de 1500, vu ${updates[1]}`);
  });

  test('plafond : 2 pages au plus, même si le serveur en promet d’autres', async () => {
    // Sans plafond, une tempête `_updatedAt` (changement de pseudo → tous les
    // messages réécrits) redescendrait 60 pages, soit 1,85 Mo.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-supprimes', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    // Chaque page promet une suite : seul le plafond peut arrêter la boucle.
    const { client, urls } = clientSequence([
      page([msg('m1', 1500)], '2000'),
      page([msg('m2', 2500)], '3000'),
      page([msg('m3', 3500)], '4000'),
    ]);

    await catchUpRoom(client, engine, 'r1');

    const updates = urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'la 3e page ne doit pas être demandée');
    assert.deepEqual(d.messages, ['m1', 'm2']);
    assert.equal(d.cursors.get('r1|messages'), 3000, 'le reste est repris au prochain passage');
  });

  test('un curseur qui n’avance pas arrête la boucle — pas de sur-place', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 5000);
    d.cursors.set('r1|messages-supprimes', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([], '5000')]);

    await catchUpRoom(client, engine, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=UPDATED')).length, 1);
  });

  test('suppressions : premier passage = on cale le curseur, sans rien rapatrier', async () => {
    // Sinon on redescendrait toute la corbeille du salon depuis l'origine.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([], null)]);

    await catchUpRoom(client, engine, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=DELETED')).length, 0);
    assert.equal(d.cursors.get('r1|messages-supprimes'), 4000);
  });

  test('suppressions : passage suivant → les messages effacés côté serveur partent', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    d.cursors.set('r1|messages-supprimes', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([
      page([], null),
      { result: { deleted: [{ _id: 'm-efface' }], cursor: { next: '5000', previous: '0' } } },
      { result: { deleted: [], cursor: { next: null, previous: '0' } } },
    ]);

    await catchUpRoom(client, engine, 'r1');

    const deletion = urls.filter((u) => u.includes('type=DELETED'));
    assert.ok(deletion[0]?.includes('next=4000'));
    assert.deepEqual(d.deletedMessages, ['m-efface']);
    assert.equal(d.cursors.get('r1|messages-supprimes'), 5000);
  });

  test('suppressions : la dernière page avance le curseur sur `_deletedAt`', async () => {
    // Même piège que pour les mises à jour : sans cela, les MÊMES suppressions
    // se re-jouaient à chaque ouverture du salon.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    d.cursors.set('r1|messages-supprimes', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const erased = '2026-07-25T13:12:28.691Z'; // forme relevée sur 8.5
    const { client } = clientSequence([
      page([], null),
      {
        result: {
          deleted: [{ _id: 'm-efface', _deletedAt: erased }],
          cursor: { next: null, previous: '0' },
        },
      },
    ]);

    await catchUpRoom(client, engine, 'r1');

    assert.deepEqual(d.deletedMessages, ['m-efface']);
    assert.equal(d.cursors.get('r1|messages-supprimes'), Date.parse(erased));
  });

  test('abandonné entre la réponse et l’écriture : rien n’est écrit', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 2000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = clientSequence([page([msg('m1', 2500)], null)]);
    await catchUpRoom(client, engine, 'r1', () => true);
    assert.equal(d.messages.length, 0);
  });

  test('un timeout REMONTE sans basculer en mode non borné', async () => {
    // Le repli ne doit se déclencher que sur des paramètres refusés (400).
    // Basculer sur `lastUpdate` parce que le réseau flanche rapporterait
    // exactement les mégaoctets qu'on cherche à éviter.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const urls: string[] = [];
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        urls.push(String(url));
        throw new Error('timeout');
      },
    });

    await assert.rejects(() => catchUpRoom(client, engine, 'r1'));

    assert.ok(!urls.some((u) => u.includes('lastUpdate')), 'aucun repli sur un timeout');
    assert.equal(d.cursors.get('r1|messages'), 1000, 'curseur intact : la reprise est exacte');
  });

  describe('repli sur un serveur sans mode curseur (< 7.5)', () => {
    const day = 24 * 60 * 60 * 1000;

    test('400 sur la première page → lastUpdate, fenêtre ramenée à 24 h', async () => {
      const now = 100 * day;
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 2 * day); // 98 jours de retard
      const engine = new SyncEngine(d.store, new RcTranslator());
      const { client, urls } = clientSequence([400, { result: { updated: [] } }]);

      await catchUpRoom(client, engine, 'r1', () => false, () => now);

      const expected = encodeURIComponent(new Date(now - day).toISOString());
      assert.ok(urls[1]?.includes(`lastUpdate=${expected}`), `vu ${urls[1]}`);
    });

    test('une réponse SANS cursor vaut refus — le serveur ignore les paramètres', async () => {
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 2000);
      const engine = new SyncEngine(d.store, new RcTranslator());
      const { client, urls } = clientSequence([
        { result: { updated: [] } },
        { result: { updated: [msg('m1', 2600)] } },
      ]);

      await catchUpRoom(client, engine, 'r1', () => false, () => 3000);

      assert.ok(urls[1]?.includes('lastUpdate'), `vu ${urls[1]}`);
      assert.deepEqual(d.messages, ['m1']);
    });

    test('le repli échoue → curseur RÉ-ANCRÉ sur le dernier message local', async () => {
      // Sans mode curseur, la requête n'est pas bornée et timeoute sur un gros
      // backlog. Le curseur ne s'avançant qu'APRÈS ingestion, il resterait
      // coincé → boucle sans fin. Le ré-ancrage ne vaut que pour ce chemin-là.
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 1000);
      d.setLastLocal(9000);
      const engine = new SyncEngine(d.store, new RcTranslator());
      let first = true;
      const client = new ClientRest('http://x', {
        fetch: async () => {
          if (first) {
            first = false;
            return new Response(JSON.stringify({ success: false }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw new Error('timeout');
        },
        sleep: async () => {},
      });

      await assert.rejects(() => catchUpRoom(client, engine, 'r1'));
      assert.equal(d.cursors.get('r1|messages'), 9000);
    });
  });
});

/**
 * Client dont chaque réponse est RETENUE jusqu'à ce que le test l'ouvre. C'est
 * le seul moyen d'observer la concurrence : avec des réponses immédiates, tout
 * s'exécute déjà en file et on ne prouverait rien.
 */
function heldClient(responses: (Record<string, unknown> | number)[]) {
  const urls: string[] = [];
  const gates: (() => void)[] = [];
  let i = 0;
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      await new Promise<void>((open) => gates.push(open));
      if (r === 0) throw new Error('réseau coupé'); // 0 = échec de transport
      const status = typeof r === 'number' ? r : 200;
      const body = typeof r === 'number' ? { success: false, error: 'params' } : r;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  /** Laisse les promesses déjà prêtes se dérouler — jamais un délai. */
  const turn = () => new Promise<void>((r) => setImmediate(r));
  return {
    client,
    urls,
    turn,
    /** Ouvre les portes au fur et à mesure, jusqu'à ce qu'il n'en reste plus. */
    openAll: async () => {
      for (let watchdog = 0; watchdog < 50; watchdog++) {
        const gate = gates.shift();
        if (gate === undefined) {
          await turn();
          if (gates.length === 0) return;
          continue;
        }
        gate();
        await turn();
      }
    },
  };
}

describe('rattraperSalon — une pagination à la fois par salon', () => {
  /** Un dépôt déjà amorcé : curseurs posés sur les deux flux. */
  function bench() {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-supprimes', 9_000_000);
    return { d, engine: new SyncEngine(d.store, new RcTranslator()) };
  }

  test('trois demandes concurrentes ne lancent PAS trois paginations', async () => {
    // Le défaut vécu : à chaque raccordement, `ui/sync.tsx` et l'effet
    // d'ouverture de l'écran (réveillé par le bump de `generation` que ce même
    // raccordement vient de poser) partaient tous deux sur le MÊME curseur,
    // pour redemander la même tranche.
    const { d, engine } = bench();
    const h = heldClient([page([], null)]);

    const requests = [
      catchUpRoom(h.client, engine, 'r1'),
      catchUpRoom(h.client, engine, 'r1'),
      catchUpRoom(h.client, engine, 'r1'),
    ];
    await h.turn();

    assert.equal(h.urls.length, 1, 'une seule requête en vol, pas trois');

    await h.openAll();
    await Promise.all(requests);
    assert.equal(d.cursors.get('r1|messages'), 1000);
  });

  test('mais aucune demande n’est AVALÉE : la seconde obtient sa lecture', async () => {
    // C'est la contrainte inverse, et elle prime. `lib/connectionSetup.ts` lit
    // DEUX fois par raccordement, et la seconde — celle qui part une fois les
    // souscriptions armées — est la seule à garantir que rien n'est tombé
    // entre les deux transports. La refuser laissait un trou définitif : le
    // curseur avait avancé, plus rien ne redemandait cette fenêtre.
    const { d, engine } = bench();
    const h = heldClient([page([], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn(); // la première pagination est partie
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await Promise.all([p1, p2]);

    const updates = h.urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'la demande arrivée en cours de route a bien lu');
    assert.equal(d.cursors.get('r1|messages'), 1000);
  });

  test('la passe chaînée repart du curseur AVANCÉ — pas une seconde fois la même tranche', async () => {
    // C'est ce qui rend la garantie peu coûteuse : la seconde lecture ne
    // repagine pas, elle vérifie. ~92 octets mesurés quand rien n'a bougé.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await Promise.all([p1, p2]);

    const updates = h.urls.filter((u) => u.includes('type=UPDATED'));
    assert.ok(updates[0]?.includes('next=1000'), `1re passe, vu ${updates[0]}`);
    assert.ok(updates[1]?.includes('next=1500'), `2e passe sur le curseur neuf, vu ${updates[1]}`);
    assert.deepEqual(d.messages, ['m1', 'm1'], 'idempotent : la 2e ré-ingère sans dupliquer');
  });

  test('les passes ne s’ENTRELACENT pas : la seconde attend la fin de la première', async () => {
    const { engine } = bench();
    const h = heldClient([page([], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();

    assert.equal(h.urls.length, 1, 'la 2e passe n’a rien envoyé tant que la 1re court');

    await h.openAll();
    await Promise.all([p1, p2]);
  });

  test('une passe REJOINTE n’abandonne que si TOUS ses demandeurs ont lâché', async () => {
    // Le rejoignant hérite de la passe, pas de l'abandon du premier arrivé :
    // un effet rejoué (changement de `generation`) pose `annule = true` sur
    // l'ancien passage juste avant de relancer le nouveau. S'exclure sur le
    // seul premier prédicat rendrait une promesse tenue sans avoir rien lu.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    let unmounted = false;
    const p2 = catchUpRoom(h.client, engine, 'r1', () => unmounted);
    const p3 = catchUpRoom(h.client, engine, 'r1'); // rejoint la passe de p2
    unmounted = true; // l'écran de p2 s'en va, celui de p3 reste

    await h.openAll();
    await Promise.all([p1, p2, p3]);

    assert.equal(
      h.urls.filter((u) => u.includes('type=UPDATED')).length,
      2,
      'la passe rejointe a bien lu',
    );
    assert.deepEqual(d.messages, ['m1', 'm1']);
  });

  test('… et elle abandonne bien quand ils ont TOUS lâché', async () => {
    // Preuve par retrait du test précédent : sans ce cas, `every` pourrait
    // n'être qu'un `some` déguisé et personne ne le verrait.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1', () => true);
    const p3 = catchUpRoom(h.client, engine, 'r1', () => true);

    await h.openAll();
    await Promise.all([p1, p2, p3]);

    assert.deepEqual(d.messages, ['m1'], 'seule la 1re passe a écrit');
  });

  test('l’échec d’une passe n’annule pas la demande de la suivante', async () => {
    const { d, engine } = bench();
    const h = heldClient([0, page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await assert.rejects(() => p1, 'l’échec reste l’échec de SON demandeur');
    await p2;

    assert.deepEqual(d.messages, ['m1'], 'la seconde a lu quand même');
  });

  test('une passe d’une session RANGÉE ne retient pas celle de la nouvelle', async () => {
    // Au changement de compte ou de serveur, le client d'avant est rangé et son
    // `estAbandonne` restera vrai à jamais. Se chaîner derrière lui ferait
    // attendre la session neuve pour rien — jusqu'au timeout de 15 s.
    const { engine } = bench();
    const old = heldClient([page([], null)]);
    const fresh = heldClient([page([], null)]);

    const p1 = catchUpRoom(old.client, engine, 'r1', () => true);
    await old.turn();
    const p2 = catchUpRoom(fresh.client, engine, 'r1');
    await fresh.turn();

    assert.equal(fresh.urls.length, 1, 'la nouvelle session lit tout de suite');

    await old.openAll();
    await fresh.openAll();
    await Promise.all([p1, p2]);
  });

  test('une fois tout retombé, la demande suivante repart d’une passe neuve', async () => {
    // Sinon l'entrée resterait dans la table à vie et chaque ouverture se
    // chaînerait derrière une promesse morte.
    const { engine } = bench();
    const h = heldClient([page([], null)]);

    await (async () => {
      const p = catchUpRoom(h.client, engine, 'r1');
      await h.openAll();
      await p;
    })();
    const before = h.urls.length;

    const p2 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    assert.ok(h.urls.length > before, 'elle est partie sans attendre personne');

    await h.openAll();
    await p2;
  });
});

describe('reconcilierSalons', () => {
  test('purge les rids absents de la liste vivante des abonnements', async () => {
    const d = fullFakeStore();
    d.known.push('r1', 'r2', 'rFantome');
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      'subscriptions.get': { update: [{ rid: 'r1' }, { rid: 'r2' }] },
    });
    await reconcileRooms(client, engine);
    // Full : pas d'updatedSince — on veut l'état courant, pas un delta.
    assert.match(urls[0], /\/subscriptions\.get(\?|$)/);
    assert.doesNotMatch(urls[0], /updatedSince/);
    assert.deepEqual(d.purges, [{ alive: ['r1', 'r2'], known: ['r1', 'r2', 'rFantome'] }]);
  });

  test('l’instantané des connus est relevé AVANT la requête réseau', async () => {
    const d = fullFakeStore();
    d.known.push('r1', 'r2');
    const engine = new SyncEngine(d.store, new RcTranslator());
    // Le stream DDP écrit un DM tout neuf pendant l'aller-retour. Il n'est ni
    // dans la réponse du serveur (calculée avant qu'il existe), ni dans
    // l'instantané — donc la purge ne doit pas pouvoir l'atteindre.
    const { client } = fakeClient(
      { 'subscriptions.get': { update: [{ rid: 'r1' }] } },
      () => void d.known.push('rNeuf'),
    );
    await reconcileRooms(client, engine);
    assert.deepEqual(d.purges, [{ alive: ['r1'], known: ['r1', 'r2'] }]);
    assert.ok(!d.purges[0].known.includes('rNeuf'), 'le DM né en vol est hors de portée');
  });


  test('une liste vide ne purge RIEN — garde-fou anti-purge-totale', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({ 'subscriptions.get': { update: [] } });
    await reconcileRooms(client, engine);
    assert.equal(d.purges.length, 0);
  });

  test('abandonné en vol : aucune purge', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({ 'subscriptions.get': { update: [{ rid: 'r1' }] } });
    await reconcileRooms(client, engine, () => true);
    assert.equal(d.purges.length, 0);
  });
});
