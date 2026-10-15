import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { TransportUpload } from '../../lib/upload.ts';
import type { UploadRow, UploadStore } from '../../lib/uploadQueue.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { COOKIE, TOKEN, fakeSlack, historyOf, message, type SlackCall } from './testing.ts';
import { SlackUploadQueue, uploadUrl } from './uploads.ts';

const UPLOAD_URL = 'https://files.slack.com/upload/v1/ABC123';

function memoryUploads() {
  const rows = new Map<string, UploadRow>();
  const failed: string[] = [];
  const store: UploadStore = {
    insert: async (l) => void rows.set(l.id, { ...l, status: 'pending', fileId: null }),
    listToSend: async () => [...rows.values()].filter((l) => l.status === 'pending'),
    claim: async (id) => {
      const l = rows.get(id);
      if (l === undefined || l.status !== 'pending') return false;
      l.status = 'sending';
      return true;
    },
    rearmInFlight: async (here) => {
      for (const l of rows.values()) if (l.status === 'sending' && !here.includes(l.id)) l.status = 'pending';
    },
    rearm: async (id) => {
      const l = rows.get(id);
      if (l) l.status = 'pending';
    },
    recordFileId: async (id, fileId) => {
      const l = rows.get(id);
      if (l) l.fileId = fileId;
    },
    fileAlreadyPosted: async () => false,
    markFailed: async (id) => {
      failed.push(id);
      const l = rows.get(id);
      if (l) l.status = 'failed';
    },
    delete: async (id) => void rows.delete(id),
  };
  return { store, rows, failed };
}

function setup(options: { room?: Record<string, unknown>[]; dropComplete?: () => boolean; fileSize?: (uri: string) => Promise<number | null> } = {}) {
  const room = options.room ?? [];
  const server = fakeSlack((call: SlackCall) => {
    switch (call.method) {
      case 'files.getUploadURLExternal':
        return { body: { ok: true, upload_url: UPLOAD_URL, file_id: 'F0001' } };
      case 'files.completeUploadExternal': {
        const ts = '1780000000.000900';
        const thread = call.args.thread_ts;
        room.push(message(ts, { user: 'U000', text: call.args.initial_comment ?? '', files: [{ id: 'F0001', name: 'a.png' }], ...(thread ? { thread_ts: thread } : {}) }));
        return { body: { ok: true, files: [{ id: 'F0001', title: 'a.png' }] } };
      }
      case 'conversations.history':
        return { body: historyOf(room.filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts), call.args) };
      case 'conversations.replies':
        return { body: { ok: true, messages: room.filter((m) => m.ts === call.args.ts || m.thread_ts === call.args.ts) } };
      default:
        return undefined;
    }
  });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await server.fetcher(input, init);
    if (String(input).endsWith('files.completeUploadExternal') && options.dropComplete?.()) throw new TypeError('Network request failed');
    return response;
  }) as typeof fetch;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U000', username: 'me', displayName: null, avatar: null });
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const history = new SlackHistory(client, directory);
  const uploads = memoryUploads();
  const sent: { url: string; headers: Record<string, string>; name: string }[] = [];
  const transport: TransportUpload = async (url, headers, file, onProgress) => {
    sent.push({ url, headers, name: file.name });
    onProgress?.(1);
    return { status: 200, body: 'OK - 10' };
  };
  const ingested: Record<string, unknown>[] = [];
  let n = 0;
  const queue = new SlackUploadQueue({
    store: uploads.store, client, directory, history, transport,
    generateId: () => `up-${++n}`,
    ingest: async (doc) => void ingested.push(doc),
    fileSize: options.fileSize,
  });
  return { queue, server, sent, uploads, ingested, room };
}

const FILE = { uri: 'file:///cache/a.png', name: 'a.png', type: 'image/png', size: 10 };

describe('SlackUploadQueue', () => {
  test('URL, bytes with no credentials, then completion with the caption and thread; the posted message echoed', async () => {
    const { queue, server, sent, uploads, ingested } = setup({ room: [message('1780000000.000100')] });
    await queue.send('C001', FILE, 'see **this** @alice', 'C001:1780000000.000100');
    assert.deepEqual(server.calls[0]!.args, { filename: 'a.png', length: '10' });
    assert.deepEqual(sent, [{ url: UPLOAD_URL, headers: {}, name: 'a.png' }]);
    const complete = server.calls.find((c) => c.method === 'files.completeUploadExternal')!;
    assert.deepEqual(complete.args, {
      files: JSON.stringify([{ id: 'F0001', title: 'a.png' }]),
      channel_id: 'C001',
      initial_comment: 'see *this* <@U001>',
      thread_ts: '1780000000.000100',
    });
    assert.equal(uploads.rows.size, 0);
    assert.deepEqual(ingested.map((m) => [m.ts, m.channel]), [['1780000000.000900', 'C001']]);
  });

  test('a lost completion is never replayed when the room already carries the file', async () => {
    let drop = true;
    const { queue, server, sent, uploads, ingested } = setup({ dropComplete: () => drop });
    await queue.send('C001', FILE);
    assert.equal(uploads.rows.get('up-1')?.fileId, 'F0001');
    assert.equal(uploads.rows.get('up-1')?.status, 'pending');
    drop = false;
    await queue.process();
    assert.equal(server.calls.filter((c) => c.method === 'files.completeUploadExternal').length, 1);
    assert.equal(server.calls.filter((c) => c.method === 'files.getUploadURLExternal').length, 1);
    assert.equal(sent.length, 1);
    assert.equal(uploads.rows.size, 0);
    assert.deepEqual(ingested.map((m) => m.ts), ['1780000000.000900']);
  });

  test('a thread reply is looked for in its thread', async () => {
    let drop = true;
    const { queue, server, uploads } = setup({ room: [message('1780000000.000100')], dropComplete: () => drop });
    await queue.send('C001', FILE, undefined, 'C001:1780000000.000100');
    drop = false;
    await queue.process();
    assert.equal(server.calls.filter((c) => c.method === 'files.completeUploadExternal').length, 1);
    assert.ok(server.calls.some((c) => c.method === 'conversations.replies' && c.args.ts === '1780000000.000100'));
    assert.equal(uploads.rows.size, 0);
  });

  test('completion goes again only when no message carries the file', async () => {
    const { queue, server, uploads } = setup({ room: [message('1780000000.000100', { files: [{ id: 'F0999' }] })] });
    await uploads.store.insert({ id: 'up-0', rid: 'C001', uri: FILE.uri, name: FILE.name, type: FILE.type, caption: null, tmid: null });
    await uploads.store.recordFileId('up-0', 'F0001');
    await queue.process();
    assert.deepEqual(server.calls.map((c) => c.method), ['conversations.history', 'files.completeUploadExternal', 'conversations.history']);
    assert.equal(uploads.rows.size, 0);
  });

  test('a replayed row asks its size; without one it fails rather than guessing', async () => {
    const sizes: string[] = [];
    const { queue, server, uploads } = setup({ fileSize: async (uri) => (sizes.push(uri), uri === FILE.uri ? 42 : null) });
    await uploads.store.insert({ id: 'up-a', rid: 'C001', uri: FILE.uri, name: FILE.name, type: FILE.type, caption: null, tmid: null });
    await uploads.store.insert({ id: 'up-b', rid: 'C001', uri: 'file:///gone.png', name: 'gone.png', type: 'image/png', caption: null, tmid: null });
    await queue.process();
    assert.deepEqual(sizes, [FILE.uri, 'file:///gone.png']);
    assert.equal(server.calls[0]!.args.length, '42');
    assert.deepEqual(uploads.failed, ['up-b']);
  });

  test('bytes only go to Slack upload URLs', () => {
    assert.equal(uploadUrl(UPLOAD_URL), UPLOAD_URL);
    for (const bad of ['http://files.slack.com/upload/v1/x', 'https://evil.test/upload', 'https://files.slack.com.evil.test/x', 'https://u:p@files.slack.com/x', 42]) {
      assert.throws(() => uploadUrl(bad));
    }
  });
});
