import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UploadRow, UploadStore } from '@rocket-vibe/provider-api/uploads';
import { WhatsAppFiles } from './files.ts';

function memoryStore() {
  const rows = new Map<string, UploadRow>();
  const store: UploadStore = {
    insert: async (row) => { rows.set(row.id, { ...row, status: 'pending', fileId: null }); },
    listToSend: async () => [...rows.values()].filter((r) => r.status === 'pending'),
    claim: async (id) => { const r = rows.get(id); if (!r || r.status !== 'pending') return false; r.status = 'sending'; return true; },
    rearmInFlight: async () => { for (const r of rows.values()) if (r.status === 'sending') r.status = 'pending'; },
    rearm: async (id) => { const r = rows.get(id); if (r) r.status = 'pending'; },
    recordFileId: async () => {},
    fileAlreadyPosted: async () => false,
    markFailed: async (id) => { const r = rows.get(id); if (r) r.status = 'failed'; },
    delete: async (id) => { rows.delete(id); },
  };
  return { rows, store };
}

test('a file shows as sending until the engine records it, a refusal waits for Retry, a duplicate counts as sent', async () => {
  const { rows, store } = memoryStore();
  const commands: Record<string, unknown>[] = [];
  let n = 0;
  const files = new WhatsAppFiles(store, async (c) => { commands.push(c); return true; },
    async (file, id) => ({ path: `/cache/${id}-${file.name}`, mime: file.type, name: file.name, voice: false }), () => `ID${++n}`);
  await files.send('a@s.whatsapp.net', { uri: 'content://x', name: 'photo.jpg', type: 'image/jpeg', size: 10 }, 'Regarde');
  assert.equal(rows.get('ID1')!.status, 'sending');
  assert.deepEqual(commands[0], { type: 'upload', id: 'ID1', chat: 'a@s.whatsapp.net', path: '/cache/ID1-photo.jpg',
    mime: 'image/jpeg', name: 'photo.jpg', text: 'Regarde', voice: false });
  await files.settled('ID1');
  assert.equal(rows.size, 0);
  await files.send('a@s.whatsapp.net', { uri: 'content://y', name: 'b.pdf', type: 'application/pdf', size: 10 });
  await files.refused('ID2', 'upload_failed');
  assert.equal(rows.get('ID2')!.status, 'failed');
  await files.retry('ID2');
  assert.equal(commands.length, 3);
  assert.equal(rows.get('ID2')!.status, 'sending');
  await files.refused('ID2', 'send_already_recorded');
  assert.equal(rows.size, 0);
  await assert.rejects(files.validate({ type: 'video/mp4', size: 200 * 1024 * 1024 }));
});

test('after a restart, a file left sending goes again from its stored copy, a voice note still one', async () => {
  const { rows, store } = memoryStore();
  rows.set('OLD', { id: 'OLD', rid: 'g@g.us', uri: 'file:///cache/OLD%20x.ogg', name: 'voice.ogg', type: 'audio/ogg',
    caption: null, tmid: null, status: 'sending', fileId: null });
  const commands: Record<string, unknown>[] = [];
  const files = new WhatsAppFiles(store, async (c) => { commands.push(c); return true; }, async () => { throw new Error('unused'); }, () => 'X');
  await files.process();
  assert.deepEqual([commands[0]!.path, commands[0]!.voice], ['/cache/OLD x.ogg', true]);
});
