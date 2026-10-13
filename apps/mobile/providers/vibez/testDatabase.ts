/** Test-only adapter: execute the application's SQL against real SQLite, never a mock map. */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { NativeDatabase } from './store.ts';

export function nativeTestDatabase(filename = ':memory:', initialize = true) {
  const db = new DatabaseSync(filename);
  const directory = new URL('../../db/migrations/',import.meta.url);
  for (const name of initialize ? readdirSync(directory).filter(name => name.endsWith('.sql')).sort() : []) {
    for (const sql of readFileSync(new URL(name,directory),'utf8').split('--> statement-breakpoint')) if (sql.trim()) db.exec(sql);
  }
  let rejectSql: ((sql:string) => boolean) | null = null;
  const adapter: NativeDatabase = {
    async runAsync(sql,params) {
      if (rejectSql?.(sql)) throw new Error('Injected SQLite write failure');
      return db.prepare(sql).run(...params);
    },
    async getFirstAsync<T>(sql:string,params:(string|number|null)[]): Promise<T | null> { return (db.prepare(sql).get(...params) ?? null) as T | null; },
    async getAllAsync<T>(sql:string,params:(string|number|null)[]): Promise<T[]> { return db.prepare(sql).all(...params) as T[]; },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try { await fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return {db,adapter,failWhen(fn: ((sql:string) => boolean) | null) {rejectSql = fn;}};
}
