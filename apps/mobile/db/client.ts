/**
 * Opening the local database. **One database per server and per account**;
 * see `fileName.ts` for why.
 *
 * `enableChangeListener: true` is mandatory: without it, `useCoalescedLiveQuery`
 * would never receive write notifications and the UI would stay frozen while
 * the WebSocket feeds the database.
 *
 * WAL mode keeps a UI read from blocking a sync engine write, and the
 * other way round.
 */

import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import { createWriteQueue, type WriteQueue } from './writeQueue.ts';
import { databaseFileName } from './fileName.ts';
import * as schema from './schema.ts';

export type BaseLocale = ReturnType<typeof drizzle<typeof schema>>;

export { databaseFileName };

type Connection = { raw: SQLiteDatabase; base: BaseLocale; writeQueue: WriteQueue };

/**
 * Open connections live for the lifetime of the PROCESS: nothing calls
 * `closeDatabase` on the nominal path, and that is deliberate (see its doc).
 * Each (server, account) pair visited therefore leaves an entry here.
 */
const open = new Map<string, Connection>();

/**
 * Idempotent: two screens asking for the same database share the connection,
 * **and its write queue**, which is the invariant that really matters. The
 * queue serialises a connection's transactions (db/writeQueue.ts); two queues
 * on one connection protect against nothing, and that is what happened when
 * the caller created it itself: `SyncProvider` reruns its effect on a mere
 * rename (new `session` object for the same account), built a second queue,
 * and the two engines interleaved on a single SQLite.
 */
export function openDatabase(baseUrl: string, userId?: string): Connection {
  const name = databaseFileName(baseUrl, userId);
  const existing = open.get(name);
  if (existing) return existing;

  const raw = openDatabaseSync(name, { enableChangeListener: true });
  // WAL: a UI read does not block a sync engine write.
  // No `PRAGMA foreign_keys`: the schema declares none, on purpose.
  // A message can arrive over the WebSocket before the room containing it.
  raw.execSync('PRAGMA journal_mode = WAL;');

  const connection: Connection = {
    raw,
    base: drizzle(raw, { schema }),
    writeQueue: createWriteQueue(),
  };
  open.set(name, connection);
  return connection;
}

/**
 * **Do NOT call in a React cleanup.** The connection is shared and the
 * cleanup runs while writes from the old engine may still be in flight;
 * closing under them is worse than leaving the connection open. Kept for
 * tests and a possible account wipe, where we know nothing writes anymore.
 */
export function closeDatabase(baseUrl: string, userId?: string): void {
  const name = databaseFileName(baseUrl, userId);
  const pair = open.get(name);
  if (!pair) return;
  pair.raw.closeSync();
  open.delete(name);
}
