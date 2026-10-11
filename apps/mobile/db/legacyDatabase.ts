import { File } from 'expo-file-system';
import { backupDatabaseAsync, defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';
import { listKnownServers, readSession } from '../lib/sessionStore.ts';
import { databaseFileName, databaseIdentity, legacyDatabaseFileName } from './fileName.ts';
import { databaseOwner, upgradeAccountDatabase } from './databaseUpgrade.ts';

// A legacy name can have multiple contenders. Serialize their claims before
// copying so two account openings never inherit the same unidentified file.
const upgrades = new Map<string, Promise<void>>();
export function prepareDatabase(baseUrl: string, userId?: string): Promise<void> {
  const legacyName = legacyDatabaseFileName(baseUrl, userId);
  const previous = upgrades.get(legacyName) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(() => upgrade(baseUrl, userId));
  upgrades.set(legacyName, result);
  void result.finally(() => { if (upgrades.get(legacyName) === result) upgrades.delete(legacyName); }).catch(() => {});
  return result;
}

async function upgrade(baseUrl: string, userId?: string): Promise<void> {
  const name = databaseFileName(baseUrl, userId);
  const expected = databaseIdentity(baseUrl, userId);
  const target = await openDatabaseAsync(name);
  try {
    const targetOwner = await databaseOwner(target);
    if (targetOwner !== null) {
      if (targetOwner !== expected) throw Error('Database belongs to another account');
      return;
    }
    const legacyName = legacyDatabaseFileName(baseUrl, userId);
    if (new File(defaultDatabaseDirectory, legacyName).exists) {
      const known = await Promise.all((await listKnownServers()).map(url => readSession(url)));
      const candidates = known.flatMap(session => session && legacyDatabaseFileName(session.baseUrl, session.userId) === legacyName
        ? [databaseIdentity(session.baseUrl, session.userId)] : []);
      const legacy = await openDatabaseAsync(legacyName);
      try {
        await upgradeAccountDatabase({ identity: expected, candidates, legacy, target,
          copy: () => backupDatabaseAsync({ sourceDatabase: legacy, destDatabase: target }) });
      } finally { await legacy.closeAsync(); }
    }
    await upgradeAccountDatabase({ identity: expected, candidates: [], legacy: null, target, copy: async () => {} });
  } finally { await target.closeAsync(); }
}
