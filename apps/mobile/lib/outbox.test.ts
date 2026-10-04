import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OutboxEngine, idFromBytes, type OutboxEncryptor, type OutboxStore, type OutboxRow } from './outbox.ts';
import type { MessageLocal } from './normalize.ts';
import { ClientRest } from './rest.ts';

function fakeStore(encrypted: ReadonlySet<string> = new Set()) {
  const outbox = new Map<string, OutboxRow>();
  const messages: MessageLocal[] = [];
  const store: OutboxStore = {
    insertOutbox: async (id, rid, text, threadId) =>
      void outbox.set(id, { id, rid, text, threadId, status: 'en-attente', attempts: 0 }),
    listToSend: async () => [...outbox.values()],
    markFailed: async (id, error) => {
      const l = outbox.get(id);
      if (l) {
        l.status = 'echec';
        l.attempts++;
        void error;
      }
    },
    deleteOutbox: async (id) => void outbox.delete(id),
    upsertMessage: async (m) => void messages.push(m),
    deleteOptimisticMessage: async (id) => {
      const i = messages.findIndex((m) => m.id === id && m.updatedAt === 0);
      if (i !== -1) messages.splice(i, 1);
    },
    roomEncrypted: async (rid) => encrypted.has(rid),
  };
  return { store, outbox, messages };
}

/** Client REST réel, fetch simulé : on éprouve la vraie sérialisation. */
function fakeClient(
  reply: (body: Record<string, unknown>) => Promise<Response>,
  replyGet?: (url: string) => Promise<Response>,
) {
  const queries: Record<string, unknown>[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      if (init?.body === undefined) {
        // GET (chat.getMessage) : introuvable par défaut.
        return replyGet
          ? replyGet(String(url))
          : ok({ success: false, error: 'not-found' });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      queries.push(body);
      return reply(body);
    },
    sleep: async () => {},
  });
  return { client, queries };
}

const ok = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });

function testEngine(options: {
  reply: (body: Record<string, unknown>) => Promise<Response>;
  replyGet?: (url: string) => Promise<Response>;
  encrypted?: ReadonlySet<string>;
  encryptor?: OutboxEncryptor;
}) {
  const { store, outbox, messages } = fakeStore(options.encrypted);
  const { client, queries } = fakeClient(options.reply, options.replyGet);
  const ingested: Record<string, unknown>[] = [];
  let n = 0;
  const engine = new OutboxEngine({
    store,
    client,
    me: { id: 'u1', username: 'alice' },
    generateId: () => `id-genere-${++n}`.padEnd(24, '0'),
    ingest: async (doc) => void ingested.push(doc),
    encryptor: options.encryptor,
    now: () => 1000,
  });
  return { engine, outbox, messages, queries, ingested };
}

describe('idDepuisOctets', () => {
  test('24 hexadécimaux, déterministes depuis les octets', () => {
    const id = idFromBytes(new Uint8Array([0, 1, 255, 16, 32, 64, 128, 200, 9, 10, 11, 12]));
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(id, '0001ff10204080c8090a0b0c');
  });
});

describe('MoteurEnvoi', () => {
  test('envoyer : affichage optimiste AVANT le réseau, puis envoi et réconciliation', async () => {
    const { engine, outbox, messages, queries, ingested } = testEngine({
      reply: async (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });

    const id = await engine.send('r1', 'bonjour');

    assert.equal(messages.length, 1, 'le message optimiste est écrit en base');
    assert.equal(messages[0].id, id);
    assert.equal(messages[0].updatedAt, 0, 'toujours écrasable par le serveur');

    assert.equal(queries.length, 1);
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent._id, id, 'le serveur reçoit le MÊME _id : sa clé de déduplication');
    assert.equal(sent.msg, 'bonjour');

    assert.equal(outbox.size, 0, 'la file est vidée au succès');
    assert.equal(ingested.length, 1, 'le document du serveur repasse par la synchro');
  });

  test('réponse de fil : `tmid` part au serveur, `filId` persiste pour le rejeu (8.3)', async () => {
    const { engine, outbox, queries } = testEngine({
      reply: async (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });
    await engine.send('r1', 'réponse dans le fil', 'racine-du-fil-000000000');
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent.tmid, 'racine-du-fil-000000000');
    assert.equal(outbox.size, 0);

    // Un message ORDINAIRE n'a pas de clé `tmid` du tout — pas un null.
    await engine.send('r1', 'hors fil');
    const ordinary = (queries[1].message ?? {}) as Record<string, unknown>;
    assert.ok(!('tmid' in ordinary));
  });

  test('réseau injoignable : la ligne RESTE en-attente, prête pour le rejeu', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await engine.send('r1', 'hors ligne');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'en-attente', "pas un échec : le réseau reviendra");
  });

  test('refus du serveur : échec actionnable, PAS de suppression', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'error-not-allowed' }),
    });
    await engine.send('r1', 'refusé');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'echec');
    assert.equal(rows[0].attempts, 1);
  });

  test('un rejeu refusé mais DÉJÀ LIVRÉ est réconcilié, pas marqué échec', async () => {
    // Rocket.Chat 8.5 répond 400 sur un `_id` déjà accepté (vérifié : « Cannot
    // read properties of undefined (reading 'starred') ») : aucun doublon,
    // mais la réponse ne vaut pas refus — on demande à chat.getMessage.
    const { engine, outbox } = testEngine({
      reply: async () =>
        ok({ success: false, error: "Cannot read properties of undefined (reading 'starred')" }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id } });
      },
    });
    await engine.send('r1', 'rejoué après crash');
    assert.equal(outbox.size, 0, 'livré = réconcilié');
  });

  test('le document du « déjà livré » est INGÉRÉ : la version serveur remplace l’optimiste', async () => {
    const { engine, ingested } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id, msg: 'version serveur' } });
      },
    });
    await engine.send('r1', 'x');
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].msg, 'version serveur');
  });

  /**
   * La vérification « déjà livré ? » peut elle-même échouer — et « je n'ai pas
   * pu demander » n'est PAS « le serveur dit que non ». Conclure à l'échec sur
   * un réseau mort affiche « non envoyé » sur un message que le serveur a
   * peut-être accepté ; l'utilisateur le retape, il en aura deux.
   */
  test('vérification impossible (réseau mort) : la ligne reste en-attente, pas en échec', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await engine.send('r1', 'peut-être livré');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'en-attente', 'dans le doute, on ne condamne pas');
    assert.equal(rows[0].attempts, 0, 'et on ne consomme pas une tentative');
  });

  /**
   * `chat.getMessage` subit la même limite REST de 10/min que `chat.sendMessage`
   * (CLAUDE.md) : une rafale d'envois épuise le quota et TOUTES les
   * vérifications retombent en 429, après les trois rejeux de `ClientRest`.
   */
  test('vérification rate-limitée (429) : la ligne reste en-attente', async () => {
    let gets = 0;
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        gets++;
        return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await engine.send('r1', 'quota épuisé');
    assert.ok(gets > 1, 'ClientRest rejoue bien le 429 avant d’abandonner');
    assert.equal([...outbox.values()][0]?.status, 'en-attente');
  });

  test('le serveur qui répond « ce message n’existe pas » vaut, LUI, un échec', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      // Réponse HTTP franche : le serveur a parlé, le message n'est pas là.
      replyGet: async () => ok({ success: false, error: 'error-invalid-message' }),
    });
    await engine.send('r1', 'vraiment refusé');
    assert.equal([...outbox.values()][0]?.status, 'echec', 'un verdict du serveur tranche');
  });

  test('abandonner efface la ligne de sortie ET le message optimiste', async () => {
    const { engine, outbox, messages } = testEngine({
      reply: async () => ok({ success: false, error: 'refus définitif' }),
    });
    const id = await engine.send('r1', 'condamné');
    assert.equal([...outbox.values()][0]?.status, 'echec');

    await engine.discard(id);
    assert.equal(outbox.size, 0);
    assert.equal(messages.length, 0, "l'optimiste ne doit pas hanter le salon");
  });

  test('un envoi pendant le flush est repris par une repasse, pas oublié', async () => {
    // Course réelle : envoyer('b') pendant que le POST de 'a' est en vol.
    // Sans repasse, 'b' resterait « ⏳ » jusqu'au prochain déclencheur.
    const valve: { open: (() => void) | null } = { open: null };
    let first = true;
    const { engine, queries, outbox } = testEngine({
      reply: (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        if (!first) return Promise.resolve(ok({ success: true, message: m }));
        first = false;
        return new Promise((resolve) => {
          valve.open = () => resolve(ok({ success: true, message: m }));
        });
      },
    });

    const p1 = engine.send('r1', 'a');
    await new Promise((r) => setImmediate(r)); // 'a' atteint le réseau
    const p2 = engine.send('r1', 'b'); // pendant le vol de 'a'
    await new Promise((r) => setImmediate(r));
    valve.open?.();
    await Promise.all([p1, p2]);

    assert.equal(queries.length, 2, "la repasse a envoyé 'b'");
    assert.equal(outbox.size, 0);
  });

  test('le rejeu retente les échecs comme les attentes', async () => {
    let refuser = true;
    const { engine, outbox } = testEngine({
      reply: async (body) => {
        if (refuser) return ok({ success: false, error: 'temporaire' });
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: m });
      },
    });
    await engine.send('r1', 'a');
    assert.equal([...outbox.values()][0]?.status, 'echec');

    refuser = false;
    await engine.process();
    assert.equal(outbox.size, 0, 'le rejeu a vidé la file');
  });

  test('deux traiter() concurrents ne doublent pas les requêtes', async () => {
    // Propriété d'objet et non variable locale : TypeScript ne voit pas
    // l'affectation faite dans l'exécuteur de la promesse.
    const valve: { open: (() => void) | null } = { open: null };
    const { engine, queries } = testEngine({
      reply: (body) =>
        new Promise((resolve) => {
          valve.open = () => {
            const m = (body.message ?? {}) as Record<string, unknown>;
            resolve(ok({ success: true, message: m }));
          };
        }),
    });
    const p1 = engine.send('r1', 'x');
    // Laisser la première passe atteindre le réseau (et bloquer sur la vanne).
    await new Promise((r) => setImmediate(r));
    // Pendant que l'envoi est en vol, un second passage ne doit rien faire —
    // et surtout ne pas bloquer : on ne l'attend qu'après avoir ouvert la vanne.
    const p2 = engine.process();
    valve.open?.();
    await Promise.all([p1, p2]);
    assert.equal(queries.length, 1);
  });
});

describe('MoteurEnvoi — salon chiffré', () => {
  const echo = async (body: Record<string, unknown>) => {
    const m = (body.message ?? {}) as Record<string, unknown>;
    return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
  };
  const encryptor: OutboxEncryptor = {
    encrypt: (rid, payload) => ({
      algorithm: 'rc.v2.aes-sha2',
      kid: `kid-${rid}`,
      iv: 'aXY=',
      ciphertext: Buffer.from(JSON.stringify(payload)).toString('base64'),
    }),
  };

  test('le texte part chiffré, jamais en clair, avec ses mentions et son fil', async () => {
    const { engine, messages, queries, outbox } = testEngine({ reply: echo, encrypted: new Set(['p1']), encryptor });

    await engine.send('p1', 'salut @bob', 'racine');

    assert.equal(messages[0].systemType, 'e2e', "l'optimiste est un message chiffré…");
    assert.equal(messages[0].text, 'salut @bob', '…affiché en clair localement');
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent.msg, undefined, 'aucun clair sur le réseau');
    assert.equal(sent.t, 'e2e');
    assert.equal(sent.e2e, 'pending');
    assert.equal(sent.tmid, 'racine');
    const content = sent.content as { kid: string; ciphertext: string };
    assert.equal(content.kid, 'kid-p1');
    assert.deepEqual(JSON.parse(Buffer.from(content.ciphertext, 'base64').toString()), { msg: 'salut @bob' });
    assert.deepEqual(sent.e2eMentions, { e2eUserMentions: ['@bob'], e2eChannelMentions: [] });
    assert.equal(outbox.size, 0);
  });

  test('verrouillé : la ligne attend sans échouer, les autres salons partent', async () => {
    let key = false;
    const { engine, queries, outbox } = testEngine({
      reply: echo,
      encrypted: new Set(['p1']),
      encryptor: { encrypt: (rid, payload) => (key ? encryptor.encrypt(rid, payload) : null) },
    });

    await engine.send('p1', 'secret');
    await engine.send('r2', 'public');

    assert.deepEqual(queries.map((r) => (r.message as { rid: string }).rid), ['r2']);
    assert.equal(outbox.size, 1);
    assert.equal([...outbox.values()][0].status, 'en-attente');

    key = true;
    await engine.process();
    assert.equal(queries.length, 2);
    assert.equal(outbox.size, 0);
  });

  test('sans chiffreur, un salon chiffré ne reçoit rien', async () => {
    const { engine, queries, outbox } = testEngine({ reply: echo, encrypted: new Set(['p1']) });
    await engine.send('p1', 'secret');
    assert.equal(queries.length, 0);
    assert.equal(outbox.size, 1);
  });
});
