import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { createOutboxStore } from './store.ts';
import { createWriteQueue } from './writeQueue.ts';
import { toMessage } from '../lib/normalize.ts';
import { nativeTestDatabase } from '../providers/vibez/testDatabase.ts';

test('optimistic text and its send intent roll back together when the second write fails', async () => {
  const h = nativeTestDatabase();
  try {
    const adapter = { ...h.adapter, async getAllAsync<T>(sql: string, params: (string | number | null)[] = []): Promise<T[]> {
      return h.db.prepare(sql).all(...params) as T[];
    } };
    const store = createOutboxStore(adapter as SQLiteDatabase, createWriteQueue());
    const message = { ...toMessage({ _id: 'local1', rid: 'room', msg: 'Hello', u: { _id: 'me', username: 'me' }, ts: 100, _updatedAt: 0 })!, text: 'Hello' };
    h.failWhen(sql => sql.includes('INSERT INTO outbox'));
    await assert.rejects(store.enqueueMessage(message), /Injected SQLite/);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, 0);
    assert.deepEqual(await store.listToSend(), []);
    h.failWhen(null);
    await store.enqueueMessage(message);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, 1);
    assert.equal((await store.listToSend())[0].id, message.id);
    assert.equal((await store.listToSend())[0].createdAt, message.ts);
  } finally { h.db.close(); }
});
