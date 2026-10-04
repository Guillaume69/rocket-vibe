import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  diffInfos,
  saveBasicInfo,
  saveStatus,
  requiresPassword,
  readMyProfile,
  profileFromMe,
  type MyProfile,
} from './myProfile.ts';
import { ClientRest } from './rest.ts';

/** Client that records every call and answers what it is given per path. */
function spyClient(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      const path = String(url).split('/api/v1/')[1] ?? '';
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify(responses[path] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  client.auth = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, calls };
}

describe('profileFromMe', () => {
  test('normalizes the present fields (statusDefault first)', () => {
    const p = profileFromMe({
      username: 'alice',
      name: 'Alice Merveille',
      status: 'online',
      statusDefault: 'busy',
      statusText: 'En réunion',
      bio: 'Développeuse',
      emails: [{ address: 'alice@x.fr', verified: true }],
    });
    assert.deepEqual(p, {
      username: 'alice',
      name: 'Alice Merveille',
      email: 'alice@x.fr',
      status: 'busy',
      statusText: 'En réunion',
      bio: 'Développeuse',
    });
  });

  test('statusDefault beats live presence (offline on a cold start)', () => {
    // The real case: app just opened, presence still offline, but the user's
    // choice is "online". The editor must show the choice.
    assert.equal(profileFromMe({ status: 'offline', statusDefault: 'online' }).status, 'online');
  });

  test('without statusDefault, falls back on status', () => {
    assert.equal(profileFromMe({ status: 'away' }).status, 'away');
  });

  test('missing fields → empty strings, unknown status → offline', () => {
    const p = profileFromMe({ username: 'bob' });
    assert.equal(p.name, '');
    assert.equal(p.email, '');
    assert.equal(p.bio, '');
    assert.equal(p.statusText, '');
    assert.equal(p.status, 'offline');
  });

  test('unlisted status → offline', () => {
    assert.equal(profileFromMe({ status: 'invisible' }).status, 'offline');
  });

  test('empty or malformed emails → empty email, no crash', () => {
    assert.equal(profileFromMe({ emails: [] }).email, '');
    assert.equal(profileFromMe({ emails: 'pas-un-tableau' }).email, '');
    assert.equal(profileFromMe({ emails: [{ verified: true }] }).email, '');
  });
});

describe('readMyProfile', () => {
  test('reads GET me and normalizes', async () => {
    const { client, calls } = spyClient({ me: { username: 'alice', status: 'online' } });
    const p = await readMyProfile(client);
    assert.equal(calls[0]?.path, 'me');
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(p.username, 'alice');
    assert.equal(p.status, 'online');
  });
});

describe('saveStatus', () => {
  test('posts status AND message together', async () => {
    const { client, calls } = spyClient();
    await saveStatus(client, { status: 'away', message: 'Déjeuner' });
    assert.equal(calls[0]?.path, 'users.setStatus');
    assert.deepEqual(calls[0]?.body, { status: 'away', message: 'Déjeuner' });
  });
});

describe('saveBasicInfo', () => {
  test('posts { data } without a 2FA header when no code', async () => {
    const { client, calls } = spyClient();
    await saveBasicInfo(client, { name: 'Alice M.' });
    assert.equal(calls[0]?.path, 'users.updateOwnBasicInfo');
    assert.deepEqual(calls[0]?.body, { data: { name: 'Alice M.' } });
    assert.equal(calls[0]?.headers.get('x-2fa-code'), null);
  });

  test('adds the x-2fa-* headers when a code is given', async () => {
    const { client, calls } = spyClient();
    await saveBasicInfo(client, { email: 'neuf@x.fr' }, { code: '123456', method: 'totp' });
    assert.equal(calls[0]?.headers.get('x-2fa-code'), '123456');
    assert.equal(calls[0]?.headers.get('x-2fa-method'), 'totp');
  });
});

describe('diffInfos', () => {
  const base: MyProfile = {
    username: 'alice',
    name: 'Alice',
    email: 'alice@x.fr',
    status: 'online',
    statusText: '',
    bio: 'Bonjour',
  };

  test('no change → empty object', () => {
    assert.deepEqual(diffInfos(base, { ...base }), {});
  });

  test('keeps only the changed fields', () => {
    const d = diffInfos(base, { ...base, name: 'Alice M.', bio: 'Salut' });
    assert.deepEqual(d, { name: 'Alice M.', bio: 'Salut' });
  });

  test('status and status text do NOT go through diffInfos', () => {
    const d = diffInfos(base, { ...base, status: 'busy', statusText: 'X' });
    assert.deepEqual(d, {});
  });
});

describe('requiresPassword', () => {
  test('email or username → true', () => {
    assert.equal(requiresPassword({ email: 'x@y.fr' }), true);
    assert.equal(requiresPassword({ username: 'neuf' }), true);
  });
  test('name or bio alone → false', () => {
    assert.equal(requiresPassword({ name: 'X', bio: 'Y' }), false);
    assert.equal(requiresPassword({}), false);
  });
});
