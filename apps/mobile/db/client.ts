/**
 * Ouverture de la base locale. **Une base par serveur et par compte** — voir
 * `fileName.ts` pour le pourquoi.
 *
 * `enableChangeListener: true` est obligatoire : sans lui, `useRequeteVive` ne
 * recevrait jamais les notifications d'écriture et l'UI resterait figée alors
 * que le WebSocket alimente la base.
 *
 * Le mode WAL évite qu'une lecture de l'UI bloque une écriture du moteur de
 * synchro, et inversement.
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
 * Les connexions ouvertes vivent pour la durée du PROCESS : rien n'appelle
 * `fermerBase` sur le chemin nominal, et c'est délibéré (voir sa doc). Chaque
 * couple (serveur, compte) visité y laisse donc une entrée.
 */
const open = new Map<string, Connection>();

/**
 * Idempotent : deux écrans qui demandent la même base partagent la connexion —
 * **et sa file d'écritures**, qui est l'invariant réellement important. La file
 * sérialise les transactions d'une connexion (db/writeQueue.ts) ; deux files
 * sur une même connexion ne protègent de rien, et c'est ce qui arrivait quand
 * l'appelant la créait lui-même : `SynchroProvider` rejoue son effet sur un
 * simple renommage (objet `session` neuf pour le même compte), fabriquait une
 * seconde file, et les deux moteurs s'entrelaçaient sur un seul SQLite.
 */
export function openDatabase(baseUrl: string, userId?: string): Connection {
  const name = databaseFileName(baseUrl, userId);
  const existing = open.get(name);
  if (existing) return existing;

  const raw = openDatabaseSync(name, { enableChangeListener: true });
  // WAL : une lecture de l'UI ne bloque pas une écriture du moteur de synchro.
  // Pas de `PRAGMA foreign_keys` : le schéma n'en déclare aucune, volontairement.
  // Un message peut arriver par le WebSocket avant le salon qui le contient.
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
 * **Ne PAS appeler dans un cleanup React.** La connexion est partagée et le
 * cleanup court pendant que des écritures de l'ancien moteur peuvent encore
 * être en vol — fermer sous elles est pire que de laisser la connexion ouverte.
 * Gardée pour les tests et un éventuel effacement de compte, où l'on sait que
 * plus rien n'écrit.
 */
export function closeDatabase(baseUrl: string, userId?: string): void {
  const name = databaseFileName(baseUrl, userId);
  const pair = open.get(name);
  if (!pair) return;
  pair.raw.closeSync();
  open.delete(name);
}
