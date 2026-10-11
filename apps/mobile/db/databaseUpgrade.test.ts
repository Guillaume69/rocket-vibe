import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { databaseOwner, upgradeAccountDatabase, type IdentityDatabase } from './databaseUpgrade.ts';
import { databaseIdentity } from './fileName.ts';

function identityDb(db: DatabaseSync): IdentityDatabase {
  return {
    async execAsync(sql) { db.exec(sql); },
    async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; },
    async runAsync(sql, params) { return db.prepare(sql).run(...params); },
  };
}

test('legacy upgrade preserves drafts and queued sends through a failed copy and retry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rv-db-upgrade-'));
  const source = new DatabaseSync(':memory:');
  const path = join(folder, 'new.db');
  const dest = new DatabaseSync(path);
  try {
    source.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('unsaved words'); CREATE TABLE outbox (id TEXT); INSERT INTO outbox VALUES ('pending-send')");
    const identity = databaseIdentity('https://chat.example', 'alice');
    const ports = { identity, candidates: [identity], legacy: identityDb(source), target: identityDb(dest) };
    await assert.rejects(upgradeAccountDatabase({ ...ports, copy: async () => { throw Error('disk busy'); } }), /disk busy/);
    assert.equal(await databaseOwner(ports.legacy), identity);
    assert.equal(await databaseOwner(ports.target), null);
    await upgradeAccountDatabase({ ...ports, copy: async () => { await backup(source, path); } });
    assert.equal(dest.prepare('SELECT text FROM drafts').get()!.text, 'unsaved words');
    assert.equal(dest.prepare('SELECT id FROM outbox').get()!.id, 'pending-send');
    dest.exec("UPDATE drafts SET text = 'new words'");
    await upgradeAccountDatabase({ ...ports, copy: async () => { throw Error('must never overwrite migrated data'); } });
    assert.equal(dest.prepare('SELECT text FROM drafts').get()!.text, 'new words');
  } finally { source.close(); dest.close(); rmSync(folder, { recursive: true }); }
});

test('colliding saved accounts receive separate caches and never claim the ambiguous legacy file', async () => {
  const source = new DatabaseSync(':memory:');
  const a = new DatabaseSync(':memory:');
  const b = new DatabaseSync(':memory:');
  try {
    source.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('private words')");
    const first = databaseIdentity('https://chat-a.example', 'u1');
    const second = databaseIdentity('https://chat.a.example', 'u1');
    for (const [identity, dest] of [[first, a], [second, b]] as const) {
      await upgradeAccountDatabase({ identity, candidates: [first, second], legacy: identityDb(source), target: identityDb(dest),
        copy: async () => { throw Error('ambiguous cache must never be copied'); } });
      assert.equal(await databaseOwner(identityDb(dest)), identity);
      assert.equal(dest.prepare("SELECT name FROM sqlite_master WHERE name = 'drafts'").get(), undefined);
    }
    assert.equal(await databaseOwner(identityDb(source)), null);
    assert.equal(source.prepare('SELECT text FROM drafts').get()!.text, 'private words');
  } finally { source.close(); a.close(); b.close(); }
});
