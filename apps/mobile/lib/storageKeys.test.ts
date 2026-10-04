import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  e2eStorageKey,
  legacyE2eStorageKey,
  readMovedKey,
  readMovedKeySync,
  sessionStorageKey,
  STORED_KEYS,
  withoutTrailingSlash,
} from './storageKeys.ts';

/** What `expo-crypto` does in the app: lowercase hex SHA-256. */
const hash = async (t: string) => createHash('sha256').update(t).digest('hex');

describe('storageKeys: key shape', () => {
  test('keys respect the alphabet imposed by expo-secure-store', async () => {
    // `[A-Za-z0-9._-]` only: a raw URL (`:`, `/`) would make the Keystore write
    // fail, hence lose the session without a word of error.
    for (const key of [
      await sessionStorageKey('https://héberge.me:3000/chat/', hash),
      await e2eStorageKey('https://héberge.me:3000/chat/', 'uid/../x', hash),
      await legacyE2eStorageKey('https://héberge.me:3000/chat/', hash),
    ]) {
      assert.match(key, /^[A-Za-z0-9._-]+$/);
    }
  });

  test('the prefix tells the two scopes apart', async () => {
    assert.match(await sessionStorageKey('https://x', hash), /^session-/);
    assert.match(await e2eStorageKey('https://x', 'u1', hash), /^e2e-/);
  });
});

describe('storageKeys: the session is per SERVER', () => {
  test('the trailing slash does not change the key', async () => {
    assert.equal(await sessionStorageKey('https://x', hash), await sessionStorageKey('https://x/', hash));
  });

  test('two distinct servers give two distinct keys', async () => {
    assert.notEqual(
      await sessionStorageKey('https://a.example', hash),
      await sessionStorageKey('https://b.example', hash),
    );
  });

  test('the account is NOT part of the session key', async () => {
    // On purpose: several servers coexist, and the session says which account.
    // The "last server" pointer only has the URL at hand.
    const expected = `session-${(await hash('https://x')).slice(0, 32)}`;
    assert.equal(await sessionStorageKey('https://x/', hash), expected);
  });
});

describe('storageKeys: the E2EE key is per (SERVER, ACCOUNT)', () => {
  test('two accounts on the SAME server do not share their private key', async () => {
    // The fixed defect: `e2e.resume()` re-imported the previous account's JWK
    // for the next one. The import SUCCEEDS (it is a valid JWK), `isUnlocked`
    // turns true, and decrypting the room keys fails silently: "encrypted,
    // read-only", with no way out.
    assert.notEqual(
      await e2eStorageKey('https://x', 'uid-alice', hash),
      await e2eStorageKey('https://x', 'uid-bob', hash),
    );
  });

  test('the same account on the same server finds its key again', async () => {
    assert.equal(await e2eStorageKey('https://x/', 'u1', hash), await e2eStorageKey('https://x', 'u1', hash));
  });

  test('the same account on two servers has two keys', async () => {
    // Two Rocket.Chat workspaces may assign the same `_id`: without the server
    // in the input, one key would unlock the other instance.
    assert.notEqual(
      await e2eStorageKey('https://a.example', 'u1', hash),
      await e2eStorageKey('https://b.example', 'u1', hash),
    );
  });

  test('the separator prevents server/account confusion', async () => {
    // Without `|`, ('https://x/a', 'b') and ('https://x/ab', '') would hash to
    // the same key: one account would read another's private key.
    assert.notEqual(await e2eStorageKey('https://x/a', 'b', hash), await e2eStorageKey('https://x/ab', '', hash));
  });

  test('an account E2EE key is NEVER the legacy server key', async () => {
    // If they matched, the migration would be a no-op and the hole would remain.
    assert.notEqual(await e2eStorageKey('https://x', 'u1', hash), await legacyE2eStorageKey('https://x', hash));
  });
});

describe('storageKeys: the legacy key stays derivable so it can be erased', () => {
  test('it is exactly what the old code wrote', async () => {
    // Literal copy of the old single-argument `e2eStorageKey(baseUrl)` of
    // sessionStore.ts. This test is the only guard of the orphaned entry:
    // `expo-secure-store` does not enumerate its keys, so if this derivation
    // drifts, a past session's DECRYPTED RSA JWK stays on the device forever.
    const old = `e2e-${(await hash('https://chat.barrut.me')).slice(0, 32)}`;
    assert.equal(await legacyE2eStorageKey('https://chat.barrut.me/', hash), old);
  });
});

describe('withoutTrailingSlash', () => {
  test('several trailing slashes go, the rest is intact', () => {
    assert.equal(withoutTrailingSlash('https://x/chat///'), 'https://x/chat');
    assert.equal(withoutTrailingSlash('https://x/chat'), 'https://x/chat');
    assert.equal(withoutTrailingSlash('https://x'), 'https://x');
  });
});

describe('storageKeys: legacy French key names move on first read', () => {
  const memory = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    const log: string[] = [];
    return {
      map,
      log,
      sync: {
        get: (k: string) => map.get(k) ?? null,
        set: (k: string, v: string) => void (log.push(`set ${k}`), map.set(k, v)),
        remove: (k: string) => void (log.push(`remove ${k}`), map.delete(k)),
      },
      async: {
        get: async (k: string) => map.get(k) ?? null,
        set: async (k: string, v: string) => void (log.push(`set ${k}`), map.set(k, v)),
        remove: async (k: string) => void (log.push(`remove ${k}`), map.delete(k)),
      },
    };
  };

  test('the old value is written under the new name, THEN the old name is deleted', async () => {
    const m = memory({ 'dernier-serveur': 'https://chat.example' });
    assert.equal(await readMovedKey(m.async, STORED_KEYS.lastServer), 'https://chat.example');
    assert.deepEqual([...m.map], [['last-server', 'https://chat.example']]);
    assert.deepEqual(m.log, ['set last-server', 'remove dernier-serveur']);
  });

  test('the new name wins and the store is left alone', async () => {
    const m = memory({ 'last-server': 'https://new', 'dernier-serveur': 'https://old' });
    assert.equal(await readMovedKey(m.async, STORED_KEYS.lastServer), 'https://new');
    assert.deepEqual(m.log, []);
  });

  test('neither name: null, nothing written', async () => {
    const m = memory({});
    assert.equal(await readMovedKey(m.async, STORED_KEYS.knownServers), null);
    assert.equal(readMovedKeySync(m.sync, STORED_KEYS.preferredLanguage), null);
    assert.deepEqual(m.log, []);
  });

  test('the synchronous variant, for values read before the first render', () => {
    const m = memory({ 'langue-preferee': 'fr' });
    assert.equal(readMovedKeySync(m.sync, STORED_KEYS.preferredLanguage), 'fr');
    assert.deepEqual([...m.map], [['preferred-language', 'fr']]);
    assert.deepEqual(m.log, ['set preferred-language', 'remove langue-preferee']);
  });

  test('the old names are exactly the ones the previous build wrote', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(STORED_KEYS).map(([k, { legacy }]) => [k, legacy])),
      {
        lastServer: 'dernier-serveur',
        knownServers: 'serveurs-connus',
        devicePushToken: 'jeton-push-appareil',
        pendingLogouts: 'deconnexions-en-suspens',
        collapsedSections: 'sections-repliees',
        preferredLanguage: 'langue-preferee',
      },
    );
  });

  test('no new name starts with `session-`, the prefix the native push service scans', () => {
    for (const { key } of Object.values(STORED_KEYS)) assert.ok(!key.startsWith('session-'), key);
  });
});
