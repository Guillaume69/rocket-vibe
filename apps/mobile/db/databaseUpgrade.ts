import { canAdoptLegacy } from './fileName.ts';

export interface IdentityDatabase {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
  runAsync(sql: string, params: string[]): Promise<unknown>;
}

const owners = 'CREATE TABLE IF NOT EXISTS rv_database_identity (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL)';
export async function databaseOwner(db: IdentityDatabase): Promise<string | null> {
  await db.execAsync(owners);
  return (await db.getFirstAsync<{ owner: string }>('SELECT owner FROM rv_database_identity WHERE id = 1'))?.owner ?? null;
}
export async function claimDatabase(db: IdentityDatabase, identity: string): Promise<void> {
  await db.runAsync('INSERT INTO rv_database_identity (id, owner) VALUES (1, ?) ON CONFLICT DO NOTHING', [identity]);
  if (await databaseOwner(db) !== identity) throw Error('Database belongs to another account');
}

export async function upgradeAccountDatabase(input: {
  identity: string;
  candidates: readonly string[];
  legacy: IdentityDatabase | null;
  target: IdentityDatabase;
  copy: () => Promise<void>;
}): Promise<void> {
  const existing = await databaseOwner(input.target);
  if (existing !== null) {
    if (existing !== input.identity) throw Error('Database belongs to another account');
    return;
  }
  if (input.legacy && canAdoptLegacy(await databaseOwner(input.legacy), input.identity, input.candidates)) {
    // Claim before copying; after a failed copy only this same owner may retry.
    await claimDatabase(input.legacy, input.identity);
    await input.copy();
  }
  await claimDatabase(input.target, input.identity);
}
