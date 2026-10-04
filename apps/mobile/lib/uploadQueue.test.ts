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
import { RestClient, RestError } from './rest.ts';
import type { FileJwk } from './e2e/crypto.ts';
import type { TransportUpload } from './upload.ts';

describe('validateFile', () => {
  test('the server max size is enforced BEFORE a single byte', () => {
    const rules = { maxSize: 1000, acceptedTypes: null, encryptedFiles: true };
    validateFile(rules, { type: 'image/png', size: 999 });
    // The refusal carries DATA (code + params), not a sentence: that is the
    // contract of the display point (ui/fileValidation.ts).
    assert.throws(
      () => validateFile(rules, { type: 'image/png', size: 1001 }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.detail.code === 'size' &&
        e.detail.maxMb === '0.0',
    );
  });

  test('the whitelist accepts `image/*` wildcards', () => {
    const rules = { maxSize: null, acceptedTypes: ['image/*', 'application/pdf'], encryptedFiles: true };
    validateFile(rules, { type: 'image/png', size: null });
    validateFile(rules, { type: 'application/pdf', size: null });
    assert.throws(
      () => validateFile(rules, { type: 'video/mp4', size: null }),
      (e: unknown) =>
        e instanceof ValidationError && e.detail.code === 'type' && e.detail.type === 'video/mp4',
    );
  });

  test('without settings, everything passes: the server will decide', () => {
    validateFile({ maxSize: null, acceptedTypes: null, encryptedFiles: true }, { type: 'x/y', size: 1e12 });
  });
});

describe('readUploadRules', () => {
  test('reads MaxFileSize and MediaTypeWhiteList from settings.public', async () => {
    const client = new RestClient('http://x', {
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
 * In-memory store that REPRODUCES the SQL semantics, in particular the filter
 * on `en-attente` and the atomic claim. A fake more permissive than the real
 * database would pass tests that production would fail.
 */
function fakeStore() {
  const rows = new Map<string, UploadRow>();
  const posted = new Set<string>();
  /** Call log: it is what tells "not marked" from "marked pending". */
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

/** A promise resolved by hand, never a delay. */
function lock() {
  let open!: () => void;
  const waitFor = new Promise<void>((r) => {
    open = r;
  });
  return { waitFor, open };
}

function confirmingClient() {
  return new RestClient('http://x', {
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

describe('UploadEngine', () => {
  test('validate refuses without persisting anything, and the settings are read only once', async () => {
    const { store, rows } = fakeStore();
    let reads = 0;
    const client = new RestClient('http://x', {
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
      transport: async () => assert.fail('validate uploads nothing'),
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

  test('persists BEFORE sending, uploads, confirms, ingests, purges', async () => {
    const { store, rows } = fakeStore();
    const ingested: unknown[] = [];
    const transport: TransportUpload = async (_url, _headers, _file, onProgress) => {
      onProgress?.(0.5);
      assert.equal(rows.size, 1, 'the intent is persisted before the byte leaves');
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

    assert.equal(rows.size, 0, 'purged on success');
    assert.equal(ingested.length, 1, 'the confirmed message goes back through sync');
  });

  test('a server refusal marks `echec`, replayable', async () => {
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
    assert.equal(engine.progress.size, 0, 'progress does not survive the failure');
  });

  /**
   * The ONLY path that left a row invisible: an unreachable network is not a
   * refusal. The row must stay `en-attente`: that is the status the room
   * banner must show, otherwise the file vanishes from the screen without a
   * sign and the user sends it again.
   */
  test('network unreachable: the row stays `en-attente`, nothing is marked failed', async () => {
    const { store, rows, calls } = fakeStore();
    const transport: TransportUpload = async () => {
      throw new RestError('Upload: server unreachable.', 0);
    };
    const engine = new UploadEngine({
      store,
      client: confirmingClient(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });

    await engine.send('r1', FILE);

    assert.equal(rows.size, 1, 'the intent survives: the replay will pick it up');
    assert.equal([...rows.values()][0]?.status, 'en-attente');
    assert.ok(
      !calls.some((a) => a.startsWith('echec:')),
      'unreachable is not a refusal: markFailed must NOT be called',
    );
    assert.equal(engine.progress.size, 0, 'progress is cleared even when the pass is abandoned');
  });

  test('unreachable stops the pass: the next row is not attempted', async () => {
    const { store, rows, calls } = fakeStore();
    let attempts = 0;
    const transport: TransportUpload = async () => {
      attempts++;
      throw new RestError('Upload: server unreachable.', 0);
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

    assert.equal(attempts, 1, 'insisting on a dead network wastes the bytes of t2');
    assert.equal(calls.filter((a) => a === 'lister').length, 1, 'no extra pass');
    // BOTH must stay replayable: t1 rearmed after its claim, t2 never touched.
    assert.deepEqual(
      [...rows.values()].map((l) => l.status),
      ['en-attente', 'en-attente'],
    );
  });

  /**
   * The trap of the `envoi` status: it takes the row out of the listing. If a
   * network failure left it in that state, the file would never leave again:
   * the original defect, only worse, since it would survive a restart.
   */
  test('a claimed then cut row becomes replayable again, not frozen in `envoi`', async () => {
    const { store, rows } = fakeStore();
    let cut = true;
    const transport: TransportUpload = async () => {
      if (cut) throw new RestError('Upload: server unreachable.', 0);
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
    assert.equal(rows.size, 0, 'with the network back, the same row finally leaves');
  });

  test('an orphaned `envoi` of a killed process is picked up at the first `process()`', async () => {
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
    // The state a kill mid-upload leaves behind.
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });
    await store.claim('t1');
    assert.equal([...rows.values()][0]?.status, 'envoi');

    await engine.process();

    assert.equal(rows.size, 0, 'without the rearm, the row would have stayed out of the listing');
  });

  test('a failure is NOT replayed on its own; "Retry" rearms it', async () => {
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

    // What `afterCatchUp` does at EVERY connection setup.
    await engine.process();
    await engine.process();
    assert.equal(attempts, 1, 'the refused video no longer pushes its bytes at every flap');

    refused = false;
    await engine.retry('t1');
    assert.equal(attempts, 2, 'the explicit gesture DOES retry');
    assert.equal(rows.size, 0);
  });

  /**
   * The lost response case: the bytes left, the server created the message,
   * but `mediaConfirm` never answered. Replaying from the start posted a
   * DUPLICATE and left one more orphan on the server.
   */
  test('a lost `mediaConfirm` uploads nothing again and posts no duplicate', async () => {
    const { store, rows, posted, calls } = fakeStore();
    let bytes = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      bytes++;
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new RestClient('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          // The response gets lost: `RestClient` turns it into a status 0.
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
    assert.ok(calls.includes('fileId:t1=f1'), 'the fileId is recorded BEFORE the confirm');
    assert.equal([...rows.values()][0]?.status, 'en-attente', 'replayable');

    // Meanwhile, the DDP stream delivered the message the confirm had created.
    posted.add('f1');

    await engine.process();

    assert.equal(bytes, 1, 'the bytes do not leave again: that is the whole point of file_id');
    assert.equal(confirms, 1, 'and NO second message is posted');
    assert.equal(rows.size, 0, 'the row is settled on the word of the local database');
    assert.equal(ingested.length, 0, 'the message is already there, ingested by the stream');
  });

  test('resume after a lost response: if the message is NOT there, only the confirm goes again', async () => {
    const { store, rows } = fakeStore();
    let bytes = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      bytes++;
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    let first = true;
    const client = new RestClient('http://x', {
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

    assert.equal(bytes, 1, 'a single pass of the bytes');
    assert.equal(confirms, 2, 'the confirm, however, is retried');
    assert.equal(rows.size, 0);
    assert.equal(ingested.length, 1);
  });

  /**
   * The hole in the local safeguard: at restart after a kill, no room screen
   * is mounted, so `stream-room-messages` is subscribed to nothing and the
   * database does not know the message created by the lost confirm. Without a
   * targeted refresh, it would confirm again, and the server then POSTS a
   * duplicate (probed on 8.5: it answers 200 returning the first message).
   */
  test('silent local database: the room is refreshed BEFORE concluding, only once', async () => {
    const { store, rows, posted } = fakeStore();
    let confirms = 0;
    const refreshed: string[] = [];
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new RestClient('http://x', {
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
      // The catch-up brings the message back: that is what `catchUpRoom` does.
      refreshRoom: async (rid) => {
        refreshed.push(rid);
        posted.add('f1');
      },
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process(); // the bytes leave, the confirm gets lost
    assert.equal(confirms, 1);
    assert.deepEqual(refreshed, [], 'no refresh on the nominal path');

    await engine.process(); // resume: the database does not know yet

    assert.deepEqual(refreshed, ['r1'], 'one targeted call, on THIS room');
    assert.equal(confirms, 1, 'and above all: no second confirm');
    assert.equal(rows.size, 0);
  });

  test('refresh impossible: the queue does not block on it', async () => {
    const { store, rows } = fakeStore();
    let confirms = 0;
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    let first = true;
    const client = new RestClient('http://x', {
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
        throw new Error('catch-up impossible');
      },
    });
    await store.insert({ id: 't1', rid: 'r1', ...FILE, caption: null });

    await engine.process();
    await engine.process();

    // Deliberate choice: when in doubt, confirm. Losing the file would be worse
    // than a visible, deletable duplicate.
    assert.equal(confirms, 2);
    assert.equal(rows.size, 0, 'the row ends up settled, not blocked forever');
  });

  test('discard interrupts the task in flight and ingests nothing', async () => {
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
      // A canceled task returns no fileId: `uploadAsync` returned null.
      if (canceled) throw new Error('Upload canceled.');
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

    assert.ok(canceled, 'the FileSystemUploadTask is really interrupted');
    assert.equal(rows.size, 0);
    assert.equal(ingested.length, 0, 'the file must not appear after a discard');
    assert.deepEqual(deleted, [FILE.uri], 'and the temporary file goes with it');
  });

  /**
   * The cancellation can LOSE the race: `cancelAsync` has no hold any more once
   * `rooms.media` is done. Two guards cover that window, and they must be
   * tested separately: the first avoids posting, the second avoids displaying
   * what could not be kept from being posted.
   */
  test('discard between the bytes and the confirm: NO message is posted', async () => {
    const { store, rows } = fakeStore();
    const entry = lock();
    const barrier = lock();
    let confirms = 0;
    const transport: TransportUpload = async () => {
      entry.open();
      await barrier.waitFor; // the discard lands here, the upload is done
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new RestClient('http://x', {
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

    assert.equal(confirms, 0, 'the confirm is what CREATES the message: do not send it');
    assert.equal(ingested.length, 0);
    assert.equal(rows.size, 0);
  });

  test('discard DURING the confirm: the posted message is not ingested', async () => {
    const { store } = fakeStore();
    const entry = lock();
    const barrier = lock();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new RestClient('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          entry.open();
          await barrier.waitFor; // the discard lands during the request
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

    // Test honesty: the server DID create the message, and the DDP stream will
    // deliver it. This does not claim to have unposted it, only not to have
    // brought it to the screen ourselves.
    assert.equal(ingested.length, 0, 'this engine does not ingest what the user discarded');
  });

  test('the temporary file is deleted on success', async () => {
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

    assert.deepEqual(deleted, [FILE.uri], 'otherwise the cache grows forever');
  });

  test('a failed deletion does not fail the send', async () => {
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
        throw new Error('file already purged by Android');
      },
    });

    await engine.send('r1', FILE);

    assert.equal(rows.size, 0, 'the message is posted: the cleanup is secondary');
  });

  /**
   * `process()` is called at every connection setup AND at every send: two
   * simultaneous passes would upload the same bytes again. The
   * `inFlight`/`rerun` guard must fold the concurrent request into a SINGLE
   * rerun, otherwise a file sent during the flush would stay pending until
   * the next trigger.
   */
  test('a concurrent `process()` becomes a rerun, not a simultaneous pass', async () => {
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
    await entry.waitFor; // the pass is REALLY in flight, no waiting delay
    await engine.process(); // must only note the rerun and return
    assert.equal(
      calls.filter((a) => a === 'lister').length,
      1,
      'the concurrent request does not reread the queue while the other pass runs',
    );

    barrier.open();
    await firstPass;

    assert.equal(
      calls.filter((a) => a === 'lister').length,
      2,
      'the noted rerun does run AT THE END of the first',
    );
    assert.equal(engine.progress.size, 0);
  });

  test('progress is cleared after a success', async () => {
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

    assert.deepEqual(seen, [1], 'the fraction is kept up to date during the send');
    assert.equal(engine.progress.size, 0, 'and removed afterwards, otherwise the bar stays at 100 %');
  });
});

describe('UploadEngine, encrypted room', () => {
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
    return new RestClient('http://x', {
      fetch: async (url, init) => {
        const confirm = String(url).includes('mediaConfirm');
        if (confirm) confirmedBodies.push(JSON.parse(String(init?.body)));
        const body = confirm ? { success: true, message: { _id: 'm1', rid: 'p1' } } : { settings };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      sleep: async () => {},
    });
  }

  test('the file leaves encrypted under the hash of its name; name, key and caption only travel encrypted', async () => {
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

  test('locked: nothing leaves, the row waits without failing', async () => {
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

  test('key lost between the two steps (killed process): the file goes again, freshly encrypted', async () => {
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

  test('server without encrypted files: refused as soon as it is added', async () => {
    const { store } = fakeStore();
    const engine = new UploadEngine({
      store,
      client: confirmingClient([], [{ _id: 'E2E_Enable_Encrypt_Files', value: false }]),
      transport: async () => assert.fail('nothing leaves'),
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

describe('encryptedFileAttachment', () => {
  const key: FileJwk = { kty: 'oct', alg: 'A256CTR', k: 'k', ext: true, key_ops: ['encrypt', 'decrypt'] };
  const common = { fileId: 'f1', url: '/file-upload/f1/h', size: 42, key, iv: 'iv', sha256: 'abc' };

  test('an image announces itself as an image', () => {
    const j = encryptedFileAttachment({ ...common, name: 'a.jpg', type: 'image/jpeg' });
    assert.equal(j.image_url, '/file-upload/f1/h');
    assert.equal(j.image_type, 'image/jpeg');
    assert.equal(j.image_size, 42);
    assert.equal(j.title_link, '/file-upload/f1/h');
  });

  test('another file carries its size and format', () => {
    const j = encryptedFileAttachment({ ...common, name: 'Rapport.PDF', type: 'application/pdf' });
    assert.equal(j.size, 42);
    assert.equal(j.format, 'pdf');
    assert.equal(j.image_url, undefined);
  });
});
