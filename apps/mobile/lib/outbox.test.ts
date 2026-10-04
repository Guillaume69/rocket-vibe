import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OutboxEngine, idFromBytes, type OutboxEncryptor, type OutboxStore, type OutboxRow } from './outbox.ts';
import type { MessageLocal } from './normalize.ts';
import { ClientRest } from './rest.ts';

function fauxDepot(chiffres: ReadonlySet<string> = new Set()) {
  const sortie = new Map<string, OutboxRow>();
  const messages: MessageLocal[] = [];
  const depot: OutboxStore = {
    insertOutbox: async (id, rid, texte, filId) =>
      void sortie.set(id, { id, rid, text: texte, threadId: filId, status: 'en-attente', attempts: 0 }),
    listToSend: async () => [...sortie.values()],
    markFailed: async (id, erreur) => {
      const l = sortie.get(id);
      if (l) {
        l.status = 'echec';
        l.attempts++;
        void erreur;
      }
    },
    deleteOutbox: async (id) => void sortie.delete(id),
    upsertMessage: async (m) => void messages.push(m),
    deleteOptimisticMessage: async (id) => {
      const i = messages.findIndex((m) => m.id === id && m.updatedAt === 0);
      if (i !== -1) messages.splice(i, 1);
    },
    roomEncrypted: async (rid) => chiffres.has(rid),
  };
  return { depot, sortie, messages };
}

/** Client REST réel, fetch simulé : on éprouve la vraie sérialisation. */
function fauxClient(
  repondre: (corps: Record<string, unknown>) => Promise<Response>,
  repondreGet?: (url: string) => Promise<Response>,
) {
  const requetes: Record<string, unknown>[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      if (init?.body === undefined) {
        // GET (chat.getMessage) : introuvable par défaut.
        return repondreGet
          ? repondreGet(String(url))
          : ok({ success: false, error: 'not-found' });
      }
      const corps = JSON.parse(String(init.body)) as Record<string, unknown>;
      requetes.push(corps);
      return repondre(corps);
    },
    sleep: async () => {},
  });
  return { client, requetes };
}

const ok = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });

function moteurDeTest(options: {
  reply: (corps: Record<string, unknown>) => Promise<Response>;
  replyGet?: (url: string) => Promise<Response>;
  encrypted?: ReadonlySet<string>;
  encryptor?: OutboxEncryptor;
}) {
  const { depot, sortie, messages } = fauxDepot(options.encrypted);
  const { client, requetes } = fauxClient(options.reply, options.replyGet);
  const ingeres: Record<string, unknown>[] = [];
  let n = 0;
  const moteur = new OutboxEngine({
    store: depot,
    client,
    me: { id: 'u1', username: 'alice' },
    generateId: () => `id-genere-${++n}`.padEnd(24, '0'),
    ingest: async (doc) => void ingeres.push(doc),
    encryptor: options.encryptor,
    now: () => 1000,
  });
  return { moteur, sortie, messages, requetes, ingeres };
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
    const { moteur, sortie, messages, requetes, ingeres } = moteurDeTest({
      reply: async (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });

    const id = await moteur.send('r1', 'bonjour');

    assert.equal(messages.length, 1, 'le message optimiste est écrit en base');
    assert.equal(messages[0].id, id);
    assert.equal(messages[0].updatedAt, 0, 'toujours écrasable par le serveur');

    assert.equal(requetes.length, 1);
    const envoye = (requetes[0].message ?? {}) as Record<string, unknown>;
    assert.equal(envoye._id, id, 'le serveur reçoit le MÊME _id : sa clé de déduplication');
    assert.equal(envoye.msg, 'bonjour');

    assert.equal(sortie.size, 0, 'la file est vidée au succès');
    assert.equal(ingeres.length, 1, 'le document du serveur repasse par la synchro');
  });

  test('réponse de fil : `tmid` part au serveur, `filId` persiste pour le rejeu (8.3)', async () => {
    const { moteur, sortie, requetes } = moteurDeTest({
      reply: async (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });
    await moteur.send('r1', 'réponse dans le fil', 'racine-du-fil-000000000');
    const envoye = (requetes[0].message ?? {}) as Record<string, unknown>;
    assert.equal(envoye.tmid, 'racine-du-fil-000000000');
    assert.equal(sortie.size, 0);

    // Un message ORDINAIRE n'a pas de clé `tmid` du tout — pas un null.
    await moteur.send('r1', 'hors fil');
    const ordinaire = (requetes[1].message ?? {}) as Record<string, unknown>;
    assert.ok(!('tmid' in ordinaire));
  });

  test('réseau injoignable : la ligne RESTE en-attente, prête pour le rejeu', async () => {
    const { moteur, sortie } = moteurDeTest({
      reply: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await moteur.send('r1', 'hors ligne');
    const lignes = [...sortie.values()];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].status, 'en-attente', "pas un échec : le réseau reviendra");
  });

  test('refus du serveur : échec actionnable, PAS de suppression', async () => {
    const { moteur, sortie } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'error-not-allowed' }),
    });
    await moteur.send('r1', 'refusé');
    const lignes = [...sortie.values()];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].status, 'echec');
    assert.equal(lignes[0].attempts, 1);
  });

  test('un rejeu refusé mais DÉJÀ LIVRÉ est réconcilié, pas marqué échec', async () => {
    // Rocket.Chat 8.5 répond 400 sur un `_id` déjà accepté (vérifié : « Cannot
    // read properties of undefined (reading 'starred') ») : aucun doublon,
    // mais la réponse ne vaut pas refus — on demande à chat.getMessage.
    const { moteur, sortie } = moteurDeTest({
      reply: async () =>
        ok({ success: false, error: "Cannot read properties of undefined (reading 'starred')" }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id } });
      },
    });
    await moteur.send('r1', 'rejoué après crash');
    assert.equal(sortie.size, 0, 'livré = réconcilié');
  });

  test('le document du « déjà livré » est INGÉRÉ : la version serveur remplace l’optimiste', async () => {
    const { moteur, ingeres } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id, msg: 'version serveur' } });
      },
    });
    await moteur.send('r1', 'x');
    assert.equal(ingeres.length, 1);
    assert.equal(ingeres[0].msg, 'version serveur');
  });

  /**
   * La vérification « déjà livré ? » peut elle-même échouer — et « je n'ai pas
   * pu demander » n'est PAS « le serveur dit que non ». Conclure à l'échec sur
   * un réseau mort affiche « non envoyé » sur un message que le serveur a
   * peut-être accepté ; l'utilisateur le retape, il en aura deux.
   */
  test('vérification impossible (réseau mort) : la ligne reste en-attente, pas en échec', async () => {
    const { moteur, sortie } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await moteur.send('r1', 'peut-être livré');
    const lignes = [...sortie.values()];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].status, 'en-attente', 'dans le doute, on ne condamne pas');
    assert.equal(lignes[0].attempts, 0, 'et on ne consomme pas une tentative');
  });

  /**
   * `chat.getMessage` subit la même limite REST de 10/min que `chat.sendMessage`
   * (CLAUDE.md) : une rafale d'envois épuise le quota et TOUTES les
   * vérifications retombent en 429, après les trois rejeux de `ClientRest`.
   */
  test('vérification rate-limitée (429) : la ligne reste en-attente', async () => {
    let gets = 0;
    const { moteur, sortie } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        gets++;
        return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await moteur.send('r1', 'quota épuisé');
    assert.ok(gets > 1, 'ClientRest rejoue bien le 429 avant d’abandonner');
    assert.equal([...sortie.values()][0]?.status, 'en-attente');
  });

  test('le serveur qui répond « ce message n’existe pas » vaut, LUI, un échec', async () => {
    const { moteur, sortie } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'starred…' }),
      // Réponse HTTP franche : le serveur a parlé, le message n'est pas là.
      replyGet: async () => ok({ success: false, error: 'error-invalid-message' }),
    });
    await moteur.send('r1', 'vraiment refusé');
    assert.equal([...sortie.values()][0]?.status, 'echec', 'un verdict du serveur tranche');
  });

  test('abandonner efface la ligne de sortie ET le message optimiste', async () => {
    const { moteur, sortie, messages } = moteurDeTest({
      reply: async () => ok({ success: false, error: 'refus définitif' }),
    });
    const id = await moteur.send('r1', 'condamné');
    assert.equal([...sortie.values()][0]?.status, 'echec');

    await moteur.discard(id);
    assert.equal(sortie.size, 0);
    assert.equal(messages.length, 0, "l'optimiste ne doit pas hanter le salon");
  });

  test('un envoi pendant le flush est repris par une repasse, pas oublié', async () => {
    // Course réelle : envoyer('b') pendant que le POST de 'a' est en vol.
    // Sans repasse, 'b' resterait « ⏳ » jusqu'au prochain déclencheur.
    const vanne: { open: (() => void) | null } = { open: null };
    let premier = true;
    const { moteur, requetes, sortie } = moteurDeTest({
      reply: (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        if (!premier) return Promise.resolve(ok({ success: true, message: m }));
        premier = false;
        return new Promise((resoudre) => {
          vanne.open = () => resoudre(ok({ success: true, message: m }));
        });
      },
    });

    const p1 = moteur.send('r1', 'a');
    await new Promise((r) => setImmediate(r)); // 'a' atteint le réseau
    const p2 = moteur.send('r1', 'b'); // pendant le vol de 'a'
    await new Promise((r) => setImmediate(r));
    vanne.open?.();
    await Promise.all([p1, p2]);

    assert.equal(requetes.length, 2, "la repasse a envoyé 'b'");
    assert.equal(sortie.size, 0);
  });

  test('le rejeu retente les échecs comme les attentes', async () => {
    let refuser = true;
    const { moteur, sortie } = moteurDeTest({
      reply: async (corps) => {
        if (refuser) return ok({ success: false, error: 'temporaire' });
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: m });
      },
    });
    await moteur.send('r1', 'a');
    assert.equal([...sortie.values()][0]?.status, 'echec');

    refuser = false;
    await moteur.process();
    assert.equal(sortie.size, 0, 'le rejeu a vidé la file');
  });

  test('deux traiter() concurrents ne doublent pas les requêtes', async () => {
    // Propriété d'objet et non variable locale : TypeScript ne voit pas
    // l'affectation faite dans l'exécuteur de la promesse.
    const vanne: { open: (() => void) | null } = { open: null };
    const { moteur, requetes } = moteurDeTest({
      reply: (corps) =>
        new Promise((resoudre) => {
          vanne.open = () => {
            const m = (corps.message ?? {}) as Record<string, unknown>;
            resoudre(ok({ success: true, message: m }));
          };
        }),
    });
    const p1 = moteur.send('r1', 'x');
    // Laisser la première passe atteindre le réseau (et bloquer sur la vanne).
    await new Promise((r) => setImmediate(r));
    // Pendant que l'envoi est en vol, un second passage ne doit rien faire —
    // et surtout ne pas bloquer : on ne l'attend qu'après avoir ouvert la vanne.
    const p2 = moteur.process();
    vanne.open?.();
    await Promise.all([p1, p2]);
    assert.equal(requetes.length, 1);
  });
});

describe('MoteurEnvoi — salon chiffré', () => {
  const echo = async (corps: Record<string, unknown>) => {
    const m = (corps.message ?? {}) as Record<string, unknown>;
    return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
  };
  const chiffreur: OutboxEncryptor = {
    encrypt: (rid, charge) => ({
      algorithm: 'rc.v2.aes-sha2',
      kid: `kid-${rid}`,
      iv: 'aXY=',
      ciphertext: Buffer.from(JSON.stringify(charge)).toString('base64'),
    }),
  };

  test('le texte part chiffré, jamais en clair, avec ses mentions et son fil', async () => {
    const { moteur, messages, requetes, sortie } = moteurDeTest({ reply: echo, encrypted: new Set(['p1']), encryptor: chiffreur });

    await moteur.send('p1', 'salut @bob', 'racine');

    assert.equal(messages[0].systemType, 'e2e', "l'optimiste est un message chiffré…");
    assert.equal(messages[0].text, 'salut @bob', '…affiché en clair localement');
    const envoye = (requetes[0].message ?? {}) as Record<string, unknown>;
    assert.equal(envoye.msg, undefined, 'aucun clair sur le réseau');
    assert.equal(envoye.t, 'e2e');
    assert.equal(envoye.e2e, 'pending');
    assert.equal(envoye.tmid, 'racine');
    const content = envoye.content as { kid: string; ciphertext: string };
    assert.equal(content.kid, 'kid-p1');
    assert.deepEqual(JSON.parse(Buffer.from(content.ciphertext, 'base64').toString()), { msg: 'salut @bob' });
    assert.deepEqual(envoye.e2eMentions, { e2eUserMentions: ['@bob'], e2eChannelMentions: [] });
    assert.equal(sortie.size, 0);
  });

  test('verrouillé : la ligne attend sans échouer, les autres salons partent', async () => {
    let cle = false;
    const { moteur, requetes, sortie } = moteurDeTest({
      reply: echo,
      encrypted: new Set(['p1']),
      encryptor: { encrypt: (rid, charge) => (cle ? chiffreur.encrypt(rid, charge) : null) },
    });

    await moteur.send('p1', 'secret');
    await moteur.send('r2', 'public');

    assert.deepEqual(requetes.map((r) => (r.message as { rid: string }).rid), ['r2']);
    assert.equal(sortie.size, 1);
    assert.equal([...sortie.values()][0].status, 'en-attente');

    cle = true;
    await moteur.process();
    assert.equal(requetes.length, 2);
    assert.equal(sortie.size, 0);
  });

  test('sans chiffreur, un salon chiffré ne reçoit rien', async () => {
    const { moteur, requetes, sortie } = moteurDeTest({ reply: echo, encrypted: new Set(['p1']) });
    await moteur.send('p1', 'secret');
    assert.equal(requetes.length, 0);
    assert.equal(sortie.size, 1);
  });
});
