import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  readPermissionSources,
  grantedPermissions,
  roomRoles,
  sourcesPermissions,
} from './permissions.ts';

function fakeClient(failures = 0) {
  const calls: string[] = [];
  let remaining = failures;
  const client = {
    baseUrl: 'http://x',
    auth: { userId: 'u1', authToken: 't' },
    get: async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (remaining > 0) {
        remaining--;
        throw new Error('hors ligne');
      }
      if (path === 'me') return { roles: ['user'] } as T;
      return {
        update: [
          { _id: 'pin-message', roles: ['owner', 'moderator', 'admin'] },
          { _id: 'delete-own-message', roles: ['user', 'admin'] },
          { _id: 'force-delete-message', roles: ['admin', 'owner'] },
          { _id: 'bizarre', roles: 'owner' },
          { roles: ['user'] },
        ],
      } as T;
    },
  };
  return { client, calls };
}

describe('permissions', () => {
  test('granted when a global OR room role carries it', async () => {
    const sources = await readPermissionSources(fakeClient().client);
    assert.deepEqual(grantedPermissions(sources, []).sort(), ['delete-own-message']);
    assert.deepEqual(grantedPermissions(sources, ['owner']).sort(), [
      'delete-own-message',
      'force-delete-message',
      'pin-message',
    ]);
  });

  test('roomRoles reads the column, and never throws', () => {
    assert.deepEqual(roomRoles('["owner","moderator"]'), ['owner', 'moderator']);
    assert.deepEqual(roomRoles(null), []);
    assert.deepEqual(roomRoles('{pas du json'), []);
    assert.deepEqual(roomRoles('"owner"'), []);
  });

  test('one read per account, and a failure is not cached', async () => {
    const { client, calls } = fakeClient(1);
    await assert.rejects(sourcesPermissions(client));
    await sourcesPermissions(client);
    await sourcesPermissions(client);
    assert.equal(calls.filter((a) => a === 'permissions.listAll').length, 2);
  });
});
