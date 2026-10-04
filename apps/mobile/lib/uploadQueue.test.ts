import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ValidationError,
  encryptedFileAttachment,
  UploadEngine,
  readUploadRules,
  validateFile,
  type UploadStore,
  type UploadRow,
} from './uploadQueue.ts';
import { ClientRest, RestError } from './rest.ts';
import type { FileJwk } from './e2e/crypto.ts';
import type { TransportUpload } from './upload.ts';

describe('validerFichier', () => {
  test('la taille maximale du serveur est respectée AVANT le moindre octet', () => {
    const rules = { maxSize: 1000, acceptedTypes: null, encryptedFiles: true };
    validateFile(rules, { type: 'image/png', size: 999 });
    // Le refus porte une DONNÉE (code + params), pas une phrase : c'est le
    // contrat du point d'affichage (ui/fileValidation.ts).
    assert.throws(
      () => validateFile(rules, { type: 'image/png', size: 1001 }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.detail.code === 'size' &&
        e.detail.maxMb === '0.0',
    );
  });

  test('la liste blanche accepte les jokers `image/*`', () => {
    const rules = { maxSize: null, acceptedTypes: ['image/*', 'application/pdf'], encryptedFiles: true };
    validateFile(rules, { type: 'image/png', size: null });
    validateFile(rules, { type: 'application/pdf', size: null });
    assert.throws(
      () => validateFile(rules, { type: 'video/mp4', size: null }),
      (e: unknown) =>
        e instanceof ValidationError && e.detail.code === 'type' && e.detail.type === 'video/mp4',
    );
  });

  test('sans réglage, tout passe — le serveur tranchera', () => {
    validateFile({ maxSize: null, acceptedTypes: null, encryptedFiles: true }, { type: 'x/y', size: 1e12 });
  });
});

describe('lireReglesUpload', () => {
  test('lit MaxFileSize et MediaTypeWhiteList depuis settings.public', async () => {
    const client = new ClientRest('http://x', {
      fetch: async () =>
        new Response(
          JSON.stringify({
            settings: [
              { _id: 'FileUpload_MaxFileSize', value: 104857600 },
              { _id: 'FileUpload_MediaTypeWhiteList', value: 'image/*, application/pdf' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      sleep: async () => {},
    });
    const rules = await readUploadRules(client);
    assert.equal(rules.maxSize, 104857600);
    assert.deepEqual(rules.acceptedTypes, ['image/*', 'application/pdf']);
  });
});

/**
 * Dépôt en mémoire qui REPRODUIT la sémantique du SQL — en particulier le
 * filtre sur `en-attente` et l'atomicité de la prise en charge. Un faux plus
 * permissif que la vraie base ferait passer des tests que la production
 * échouerait.
 */
function fakeStore() {
  const rows = new Map<string, UploadRow>();
  const posted = new Set<string>();
  /** Journal des appels : c'est lui qui distingue « pas marqué » de « marqué en attente ». */
  const calls: string[] = [];
  const store: UploadStore = {
    insert: async (l) => void rows.set(l.id, { ...l, status: 'en-attente', fileId: null }),
    listToSend: async () => {
      calls.push('lister');
      return [...rows.values()].filter((l) => l.status === 'en-attente');
    },
    claim: async (id) => {
      const l = rows.get(id);
      if (l === undefined || l.status !== 'en-attente') return false;
      l.status = 'envoi';
      calls.push(`prendre:${id}`);
      return true;
    },
    rearmInFlight: async (inFlightHere) => {
      calls.push(`rearmerEnVol:[${inFlightHere.join(',')}]`);
      for (const l of rows.values()) {
        if (l.status === 'envoi' && !inFlightHere.includes(l.id)) l.status = 'en-attente';
      }
    },
    rearm: async (id) => {
      calls.push(`rearmer:${id}`);
      const l = rows.get(id);
      if (l) l.status = 'en-attente';
    },
    recordFileId: async (id, fileId) => {
      calls.push(`fileId:${id}=${fileId}`);
      const l = rows.get(id);
      if (l) l.fileId = fileId;
    },
    fileAlreadyPosted: async (_rid, fileId) => posted.has(fileId),
    markFailed: async (id, error) => {
      calls.push(`echec:${id}`);
      const l = rows.get(id);
      if (l) {
        l.status = 'echec';
        void error;
      }
    },
    delete: async (id) => {
      calls.push(`supprimer:${id}`);
      rows.delete(id);
    },
  };
  return { store, rows, calls, posted };
}

const FILE = { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 };

/** Une promesse qu'on dénoue à la main — jamais un délai. */
function lock() {
  let open!: () => void;
  const waitFor = new Promise<void>((r) => {
    open = r;
  });
  return { waitFor, open };
}

function confirmingClient() {
  return new ClientRest('http://x', {
    fetch: async (url) => {
      const body = String(url).includes('mediaConfirm')
        ? { success: true, message: { _id: 'm1', rid: 'r1' } }
        : { settings: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
}

describe('MoteurTeleversement', () => {
  test('valider refuse sans rien persister, et les réglages ne sont lus qu’une fois', async () => {
    const { store, rows } = fakeStore();
    let reads = 0;
    const client = new ClientRest('http://x', {
      fetch: async () => {
        reads++;
        return new Response(
          JSON.stringify({
            settings: [
              { _id: 'FileUpload_MaxFileSize', value: 100 },
              { _id: 'FileUpload_MediaTypeWhiteList', value: 'image/*' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
      sleep: async () => {},
    });
    const engine = new UploadEngine({
      store,
      client,
      transport: async () => assert.fail('valider ne téléverse rien'),
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });

    await engine.validate({ type: 'image/png', size: 99 });
    await assert.rejects(engine.validate({ type: 'image/png', size: 101 }), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'size';
    });
    await assert.rejects(engine.validate({ type: 'application/pdf', size: 1 }), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'type';
    });
    assert.equal(rows.size, 0);
    assert.equal(reads, 1);
  });

  test('persiste AVANT l’envoi, téléverse, confirme, ingère, purge', async () => {
    const { store, rows } = fakeStore();
    const ingested: unknown[] = [];
    const transport: TransportUpload = async (_url, _headers, _file, onProgress) => {
      onProgress?.(0.5);
      assert.equal(rows.size, 1, "l'intention est persistée avant que l'octet parte");
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async (doc) => void ingested.push(doc),
    });

    await engine.send('r1', { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 });

    assert.equal(rows.size, 0, 'purgé au succès');
    assert.equal(ingested.length, 1, 'le message confirmé repasse par la synchro');
  });

  test('un refus serveur marque `echec`, rejouable', async () => {
    const { store, rows } = fakeStore();
    const transport: TransportUpload = async () => ({
      status: 413,
      body: JSON.stringify({ success: false, error: 'trop gros' }),
    });
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });
    await engine.send('r1', { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 });
    assert.equal([...rows.values()][0]?.status, 'echec');
    assert.equal(engine.progress.size, 0, 'la progression ne survit pas à l’échec');
  });

  /**
   * Le SEUL chemin qui laissait une ligne invisible : le réseau injoignable
   * n'est pas un refus. La ligne doit rester `en-attente` — c'est ce statut
   * que le bandeau du salon doit afficher, sans quoi le fichier disparaît de
   * l'écran sans le moindre signe et l'utilisateur le renvoie.
   */
  test('réseau injoignable : la ligne reste `en-attente`, rien n’est marqué en échec', async () => {
    const { store, rows, calls } = fakeStore();
    const transport: TransportUpload = async () => {
      throw new RestError('Upload : serveur injoignable.', 0);
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });

    await engine.send('r1', FILE);

    assert.equal(rows.size, 1, 'l’intention survit — le rejeu la reprendra');
    assert.equal([...rows.values()][0]?.status, 'en-attente');
    assert.ok(
      !calls.some((a) => a.startsWith('echec:')),
      'un injoignable n’est pas un refus : marquerEchec ne doit PAS être appelé',
    );
    assert.equal(engine.progress.size, 0, 'la progression est vidée même sur abandon de passe');
  });

  test('un injoignable arrête la passe : la ligne suivante n’est pas tentée', async () => {
    const { store, rows, calls } = fakeStore();
    let attempts = 0;
    const transport: TransportUpload = async () => {
      attempts++;
      throw new RestError('Upload : serveur injoignable.', 0);
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });
    await store.insert({ id: 't2', rid: 'r1', ...FILE, caption: null });

    await engine.process();

    assert.equal(attempts, 1, 'insister sur un réseau mort gaspille les octets de t2');
    assert.equal(calls.filter((a) => a === 'lister').length, 1, 'aucune passe supplémentaire');
    // Les DEUX doivent rester rejouables : t1 ré-armée après sa prise en
    // charge, t2 jamais touchée.
    assert.deepEqual(
      [...rows.values()].map((l) => l.status),
      ['en-attente', 'en-attente'],
    );
  });

  /**
   * Le piège du statut `envoi` : il sort la ligne du listage. Si une panne
   * réseau la laissait dans cet état, le fichier ne repartirait plus jamais
   * — le défaut d'origine, en pire, puisqu'il survivrait au redémarrage.
   */
  test('une ligne prise en charge puis coupée redevient rejouable, pas figée en `envoi`', async () => {
    const { store, rows } = fakeStore();
    let cut = true;
    const transport: TransportUpload = async () => {
      if (cut) throw new RestError('Upload : serveur injoignable.', 0);
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    assert.equal([...rows.values()][0]?.status, 'en-attente');

    cut = false;
    await engine.process();
    assert.equal(rows.size, 0, 'le réseau revenu, la même ligne part enfin');
  });

  test('un `envoi` orphelin d’un processus tué est repris au premier `traiter()`', async () => {
    const { store, rows } = fakeStore();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    // L'état que laisse un kill en plein téléversement.
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });
    await store.claim('t1');
    assert.equal([...rows.values()][0]?.status, 'envoi');

    await engine.process();

    assert.equal(rows.size, 0, 'sans le ré-armement, la ligne serait restée hors du listage');
  });

  test('un échec n’est PAS rejoué tout seul ; « Réessayer » le ré-arme', async () => {
    const { store, rows } = fakeStore();
    let refused = true;
    let attempts = 0;
    const transport: TransportUpload = async () => {
      attempts++;
      if (refused) return { status: 413, body: JSON.stringify({ success: false, error: 'gros' }) };
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    assert.equal([...rows.values()][0]?.status, 'echec');
    assert.equal(attempts, 1);

    // Ce que fait `apresRattrapage` à CHAQUE raccordement.
    await engine.process();
    await engine.process();
    assert.equal(attempts, 1, 'la vidéo refusée ne repousse plus ses octets à chaque flap');

    refused = false;
    await engine.retry('t1');
    assert.equal(attempts, 2, 'le geste explicite, LUI, retente');
    assert.equal(rows.size, 0);
  });

  /**
   * Le cas de la réponse perdue : les octets sont partis, le serveur a créé le
   * message, mais `mediaConfirm` n'a jamais répondu. Rejouer depuis le début
   * postait un DOUBLON et laissait un orphelin de plus sur le serveur.
   */
  test('un `mediaConfirm` perdu ne re-téléverse rien et ne poste pas de doublon', async () => {
    const { store, rows, posted, calls } = fakeStore();
    let bytes = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      bytes++;
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          // La réponse se perd : `ClientRest` en fait un statut 0.
          throw new TypeError('Network request failed');
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const ingested: unknown[] = [];
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingested.push(d),
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    assert.equal(bytes, 1);
    assert.equal(confirms, 1);
    assert.ok(calls.includes('fileId:t1=f1'), 'le fileId est noté AVANT le confirm');
    assert.equal([...rows.values()][0]?.status, 'en-attente', 'rejouable');

    // Entre-temps, le stream DDP a livré le message que le confirm avait créé.
    posted.add('f1');

    await engine.process();

    assert.equal(bytes, 1, 'les octets ne repartent pas — c’est tout l’objet de file_id');
    assert.equal(confirms, 1, 'et AUCUN second message n’est posté');
    assert.equal(rows.size, 0, 'la ligne est soldée sur la foi de la base locale');
    assert.equal(ingested.length, 0, 'le message est déjà là, ingéré par le stream');
  });

  test('reprise après réponse perdue : si le message n’est PAS là, seul le confirm repart', async () => {
    const { store, rows } = fakeStore();
    let bytes = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      bytes++;
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    let first = true;
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          if (first) {
            first = false;
            throw new TypeError('Network request failed');
          }
          return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const ingested: unknown[] = [];
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingested.push(d),
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    await engine.process();

    assert.equal(bytes, 1, 'un seul passage des octets');
    assert.equal(confirms, 2, 'le confirm, lui, est bien retenté');
    assert.equal(rows.size, 0);
    assert.equal(ingested.length, 1);
  });

  /**
   * Le trou du garde-fou local : au redémarrage après un kill, aucun écran de
   * salon n'est monté, donc `stream-room-messages` n'est souscrit sur rien et
   * la base ignore le message créé par le confirm perdu. Sans rafraîchissement
   * ciblé, on re-confirmerait — et le serveur POSTE alors un doublon (sondé
   * sur 8.5 : il répond 200 en rendant le premier message).
   */
  test('base locale muette : on rafraîchit le salon AVANT de conclure, une seule fois', async () => {
    const { store, rows, posted } = fakeStore();
    let confirms = 0;
    const refreshed: string[] = [];
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          throw new TypeError('Network request failed');
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async () => {},
      // Le rattrapage rapporte le message : c'est ce que fait `rattraperSalon`.
      refreshRoom: async (rid) => {
        refreshed.push(rid);
        posted.add('f1');
      },
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process(); // les octets partent, le confirm se perd
    assert.equal(confirms, 1);
    assert.deepEqual(refreshed, [], 'aucun rafraîchissement sur le chemin nominal');

    await engine.process(); // reprise : la base ne sait pas encore

    assert.deepEqual(refreshed, ['r1'], 'un appel ciblé, sur CE salon');
    assert.equal(confirms, 1, 'et surtout : pas de second confirm');
    assert.equal(rows.size, 0);
  });

  test('rafraîchissement impossible : on ne bloque pas la file dessus', async () => {
    const { store, rows } = fakeStore();
    let confirms = 0;
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    let first = true;
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          if (first) {
            first = false;
            throw new TypeError('Network request failed');
          }
          return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async () => {},
      refreshRoom: async () => {
        throw new Error('rattrapage impossible');
      },
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    await engine.process();

    // Choix assumé : dans le doute, confirmer. Perdre le fichier serait pire
    // qu'un doublon visible et effaçable.
    assert.equal(confirms, 2);
    assert.equal(rows.size, 0, 'la ligne finit soldée, pas bloquée à vie');
  });

  test('abandonner interrompt la tâche en vol et n’ingère rien', async () => {
    const { store, rows } = fakeStore();
    const entry = lock();
    const barrier = lock();
    let canceled = false;
    const transport: TransportUpload = async (_u, _e, _f, _p, onCancelable) => {
      onCancelable?.(async () => {
        canceled = true;
        barrier.open();
      });
      entry.open();
      await barrier.waitFor;
      // Une tâche annulée ne rend pas de fileId : `uploadAsync` a rendu null.
      if (canceled) throw new Error('Téléversement annulé.');
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const ingested: unknown[] = [];
    const deleted: string[] = [];
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingested.push(d),
      deleteLocalFile: async (uri) => void deleted.push(uri),
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    const pass = engine.process();
    await entry.waitFor;
    await engine.discard('t1', FILE.uri);
    await pass;

    assert.ok(canceled, 'la FileSystemUploadTask est vraiment interrompue');
    assert.equal(rows.size, 0);
    assert.equal(ingested.length, 0, 'le fichier ne doit pas apparaître après un abandon');
    assert.deepEqual(deleted, [FILE.uri], 'et le temporaire part avec lui');
  });

  /**
   * L'annulation peut PERDRE la course : `cancelAsync` n'a plus de prise une
   * fois `rooms.media` terminé. Deux gardes couvrent cette fenêtre, et il faut
   * les éprouver séparément — la première évite de poster, la seconde évite
   * d'afficher ce qu'on n'a pas pu ne pas poster.
   */
  test('abandon entre les octets et le confirm : AUCUN message n’est posté', async () => {
    const { store, rows } = fakeStore();
    const entry = lock();
    const barrier = lock();
    let confirms = 0;
    const transport: TransportUpload = async () => {
      entry.open();
      await barrier.waitFor; // l'abandon tombe ici, l'upload est fini
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) confirms++;
        return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const ingested: unknown[] = [];
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingested.push(d),
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    const pass = engine.process();
    await entry.waitFor;
    await engine.discard('t1');
    barrier.open();
    await pass;

    assert.equal(confirms, 0, 'c’est le confirm qui CRÉE le message : ne pas l’envoyer');
    assert.equal(ingested.length, 0);
    assert.equal(rows.size, 0);
  });

  test('abandon PENDANT le confirm : le message posté n’est pas ingéré', async () => {
    const { store } = fakeStore();
    const entry = lock();
    const barrier = lock();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          entry.open();
          await barrier.waitFor; // l'abandon tombe pendant la requête
        }
        return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const ingested: unknown[] = [];
    const engine = new UploadEngine({
      store,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingested.push(d),
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    const pass = engine.process();
    await entry.waitFor;
    await engine.discard('t1');
    barrier.open();
    await pass;

    // Honnêteté du test : le serveur A créé le message, et le stream DDP le
    // livrera. On ne prétend pas l'avoir dé-posté — seulement ne pas l'avoir
    // nous-mêmes remonté à l'écran.
    assert.equal(ingested.length, 0, 'ce moteur n’ingère pas ce que l’usager a abandonné');
  });

  test('le fichier temporaire est effacé au succès', async () => {
    const { store } = fakeStore();
    const deleted: string[] = [];
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async (uri) => void deleted.push(uri),
    });

    await engine.send('r1', FILE);

    assert.deepEqual(deleted, [FILE.uri], 'sinon le cache enfle sans fin');
  });

  test('un échec d’effacement ne fait pas échouer l’envoi', async () => {
    const { store, rows } = fakeStore();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async () => {
        throw new Error('fichier déjà purgé par Android');
      },
    });

    await engine.send('r1', FILE);

    assert.equal(rows.size, 0, 'le message est posté : le ménage est secondaire');
  });

  /**
   * `traiter()` est appelé à chaque raccordement ET à chaque envoi : deux
   * passes simultanées re-téléverseraient les mêmes octets. La garde
   * `enVol`/`repasser` doit fondre la demande concurrente dans une SEULE
   * repasse — sinon un fichier envoyé pendant le flush resterait en attente
   * jusqu'au prochain déclencheur.
   */
  test('un `traiter()` concurrent devient une repasse, pas une passe simultanée', async () => {
    const { store, calls } = fakeStore();
    const entry = lock();
    const barrier = lock();
    let first = true;
    const transport: TransportUpload = async () => {
      if (first) {
        first = false;
        entry.open();
        await barrier.waitFor;
      }
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    const firstPass = engine.process();
    await entry.waitFor; // la passe est VRAIMENT en vol — aucun délai d'attente
    await engine.process(); // doit se contenter de noter la repasse et rendre
    assert.equal(
      calls.filter((a) => a === 'lister').length,
      1,
      'la demande concurrente ne relit pas la file pendant que l’autre passe court',
    );

    barrier.open();
    await firstPass;

    assert.equal(
      calls.filter((a) => a === 'lister').length,
      2,
      'la repasse notée est bien exécutée À LA FIN de la première',
    );
    assert.equal(engine.progress.size, 0);
  });

  test('la progression est vidée après un succès', async () => {
    const { store } = fakeStore();
    const seen: number[] = [];
    const transport: TransportUpload = async (_u, _e, _f, onProgress) => {
      onProgress?.(0.25);
      onProgress?.(1);
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {
        seen.push(engine.progress.get('id-fichier-000000000000') ?? -1);
      },
    });

    await engine.send('r1', FILE);

    assert.deepEqual(seen, [1], 'la fraction est bien tenue à jour pendant l’envoi');
    assert.equal(engine.progress.size, 0, 'et retirée ensuite — sinon la barre reste à 100 %');
  });
});

describe('MoteurTeleversement — salon chiffré', () => {
  const CONTENT = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'aXY=', ciphertext: 'Y3Q=' };
  const JWK: FileJwk = { kty: 'oct', alg: 'A256CTR', k: 'Y2xl', ext: true, key_ops: ['encrypt', 'decrypt'] };

  function encryption(options: { key?: () => boolean } = {}) {
    const payloads: object[] = [];
    const encryptedFiles: string[] = [];
    return {
      payloads,
      encryptedFiles,
      encryption: {
        roomEncrypted: async (rid: string) => rid === 'p1',
        encrypt: (_rid: string, payload: object) => {
          if (options.key && !options.key()) return null;
          payloads.push(payload);
          return CONTENT;
        },
        encryptFile: async (uri: string) => {
          encryptedFiles.push(uri);
          return { uri: `${uri}.chiffre`, key: JWK, iv: 'Y3RyMTY=', sha256: 'abc', size: 10 };
        },
        hashedName: (name: string) => `hache(${name})`,
      },
    };
  }

  function confirmingClient(confirmedBodies: unknown[], settings: unknown[] = []) {
    return new ClientRest('http://x', {
      fetch: async (url, init) => {
        const confirm = String(url).includes('mediaConfirm');
        if (confirm) confirmedBodies.push(JSON.parse(String(init?.body)));
        const body = confirm ? { success: true, message: { _id: 'm1', rid: 'p1' } } : { settings };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      sleep: async () => {},
    });
  }

  test('le fichier part chiffré sous l’empreinte de son nom ; nom, clé et légende ne voyagent que chiffrés', async () => {
    const { store, rows } = fakeStore();
    const { encryption: c, payloads } = encryption();
    const sends: { file: unknown; fields: unknown }[] = [];
    const confirmed: unknown[] = [];
    const deleted: string[] = [];
    const engine = new UploadEngine({
      store,
      client: confirmingClient(confirmed, [{ _id: 'E2E_Enable_Encrypt_Files', value: true }]),
      transport: async (_url, _headers, file, _p, _a, fields) => {
        sends.push({ file, fields });
        return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
      },
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async (uri) => void deleted.push(uri),
      encryption: c,
    });

    await engine.send('p1', { uri: 'file:///cache/a.png', name: 'vacances.png', type: 'image/png', size: 10 }, 'la plage');

    assert.deepEqual(sends, [
      {
        file: { uri: 'file:///cache/a.png.chiffre', name: 'hache(vacances.png)', type: 'application/octet-stream' },
        fields: { content: JSON.stringify(CONTENT) },
      },
    ]);
    assert.deepEqual(confirmed, [{ msg: '', t: 'e2e', content: CONTENT, fileContent: CONTENT }]);
    const message = payloads.find((ch) => 'attachments' in ch) as { msg: string; attachments: Record<string, unknown>[] };
    assert.equal(message.msg, 'la plage');
    assert.equal(message.attachments[0].title, 'vacances.png');
    assert.equal(message.attachments[0].image_url, '/file-upload/f1/hache(vacances.png)');
    assert.deepEqual(message.attachments[0].encryption, { key: JWK, iv: 'Y3RyMTY=' });
    assert.deepEqual(deleted, ['file:///cache/a.png.chiffre', 'file:///cache/a.png']);
    assert.equal(rows.size, 0);
  });

  test('verrouillé : rien ne part, la ligne attend sans échouer', async () => {
    const { store, rows, calls } = fakeStore();
    let key = false;
    const { encryption: c } = encryption({ key: () => key });
    let sends = 0;
    const engine = new UploadEngine({
      store,
      client: confirmingClient([], [{ _id: 'E2E_Enable_Encrypt_Files', value: true }]),
      transport: async () => {
        sends++;
        return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
      },
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      encryption: c,
    });

    await engine.send('p1', FILE);
    assert.equal(sends, 0);
    assert.equal([...rows.values()][0].status, 'en-attente');
    assert.ok(!calls.some((a) => a.startsWith('echec')));

    key = true;
    await engine.process();
    assert.equal(sends, 1);
    assert.equal(rows.size, 0);
  });

  test('clé perdue entre les deux temps (processus tué) : le fichier repart, chiffré à neuf', async () => {
    const { store, rows } = fakeStore();
    const { encryption: c, encryptedFiles } = encryption();
    await store.insert({ id: 'l1', rid: 'p1', uri: 'file:///cache/a.png', name: 'a.png', type: 'image/png', caption: null });
    await store.recordFileId('l1', 'f-ancien');
    const confirmed: unknown[] = [];
    const engine = new UploadEngine({
      store,
      client: confirmingClient(confirmed),
      transport: async () => ({ status: 200, body: JSON.stringify({ file: { _id: 'f-neuf' } }) }),
      generateId: () => 'x',
      ingest: async () => {},
      encryption: c,
    });

    await engine.process();
    assert.deepEqual(encryptedFiles, ['file:///cache/a.png']);
    assert.equal(confirmed.length, 1);
    assert.equal(rows.size, 0);
  });

  test('serveur sans fichiers chiffrés : refusé dès la pose', async () => {
    const { store } = fakeStore();
    const engine = new UploadEngine({
      store,
      client: confirmingClient([], [{ _id: 'E2E_Enable_Encrypt_Files', value: false }]),
      transport: async () => assert.fail('rien ne part'),
      generateId: () => 'x',
      ingest: async () => {},
      encryption: encryption().encryption,
    });
    await assert.rejects(engine.validate({ type: 'image/png', size: 1 }, 'p1'), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'encrypted';
    });
    await engine.validate({ type: 'image/png', size: 1 }, 'r-clair');
  });
});

describe('jointeDeFichierChiffre', () => {
  const key: FileJwk = { kty: 'oct', alg: 'A256CTR', k: 'k', ext: true, key_ops: ['encrypt', 'decrypt'] };
  const common = { fileId: 'f1', url: '/file-upload/f1/h', size: 42, key, iv: 'iv', sha256: 'abc' };

  test('une image s’annonce comme image', () => {
    const j = encryptedFileAttachment({ ...common, name: 'a.jpg', type: 'image/jpeg' });
    assert.equal(j.image_url, '/file-upload/f1/h');
    assert.equal(j.image_type, 'image/jpeg');
    assert.equal(j.image_size, 42);
    assert.equal(j.title_link, '/file-upload/f1/h');
  });

  test('un autre fichier porte son poids et son format', () => {
    const j = encryptedFileAttachment({ ...common, name: 'Rapport.PDF', type: 'application/pdf' });
    assert.equal(j.size, 42);
    assert.equal(j.format, 'pdf');
    assert.equal(j.image_url, undefined);
  });
});
