import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parsePendingLogouts, parseSession } from './storedRecords.ts';

const BASE = 'https://chat.example.org';
const SESSION = { baseUrl: BASE, authToken: 't', userId: 'u', username: 'alice', kind: 'rocketchat', siteUrl: null };

describe('parseSession', () => {
  test('a current session reads back as is', () => {
    assert.deepEqual(parseSession(JSON.stringify(SESSION), `${BASE}/`), SESSION);
  });

  test('a session written before the English rename keeps its kind (`genre`)', () => {
    const { kind: _, ...rest } = SESSION;
    const session = parseSession(JSON.stringify({ ...rest, genre: 'rocketchat' }), BASE);
    assert.equal(session?.kind, 'rocketchat');
  });

  test('no kind and no siteUrl: the defaults', () => {
    const { kind: _, siteUrl: __, ...rest } = SESSION;
    const session = parseSession(JSON.stringify(rest), BASE);
    assert.equal(session?.kind, 'rocketchat');
    assert.equal(session?.siteUrl, null);
  });

  test('corrupt, incomplete or for another server: no session', () => {
    assert.equal(parseSession('{not json', BASE), null);
    assert.equal(parseSession(JSON.stringify({ ...SESSION, authToken: 1 }), BASE), null);
    assert.equal(parseSession(JSON.stringify(SESSION), 'https://other.example.org'), null);
  });
});

describe('parsePendingLogouts', () => {
  const ENTRY = { baseUrl: BASE, authToken: 't', userId: 'u', pushToken: 'fcm-new' };

  test('a current entry reads back as is', () => {
    assert.deepEqual(parsePendingLogouts(JSON.stringify([ENTRY])), [ENTRY]);
  });

  test('an entry queued before the English rename keeps its push token (`jetonPush`)', () => {
    const { pushToken: _, ...rest } = ENTRY;
    assert.deepEqual(parsePendingLogouts(JSON.stringify([{ ...rest, jetonPush: 'fcm-old' }])), [
      { ...rest, pushToken: 'fcm-old' },
    ]);
  });

  test('the new field wins, and a missing token is null', () => {
    assert.equal(parsePendingLogouts(JSON.stringify([{ ...ENTRY, jetonPush: 'fcm-old' }]))[0]?.pushToken, 'fcm-new');
    const { pushToken: _, ...rest } = ENTRY;
    assert.equal(parsePendingLogouts(JSON.stringify([rest]))[0]?.pushToken, null);
  });

  test('corrupt storage or incomplete entries are dropped, not thrown', () => {
    assert.deepEqual(parsePendingLogouts('{not json'), []);
    assert.deepEqual(parsePendingLogouts('{"baseUrl":"x"}'), []);
    assert.deepEqual(parsePendingLogouts(JSON.stringify([{ baseUrl: BASE }, ENTRY])), [ENTRY]);
  });
});
