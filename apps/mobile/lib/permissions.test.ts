import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  readPermissionSources,
  grantedPermissions,
  roomRoles,
  sourcesPermissions,
} from './permissions.ts';

function fauxClient(echecs = 0) {
  const appels: string[] = [];
  let restants = echecs;
  const client = {
    baseUrl: 'http://x',
    auth: { userId: 'u1', authToken: 't' },
    get: async <T>(chemin: string): Promise<T> => {
      appels.push(chemin);
      if (restants > 0) {
        restants--;
        throw new Error('hors ligne');
      }
      if (chemin === 'me') return { roles: ['user'] } as T;
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
  return { client, appels };
}

describe('permissions', () => {
  test('accordée quand un rôle global OU du salon la porte', async () => {
    const sources = await readPermissionSources(fauxClient().client);
    assert.deepEqual(grantedPermissions(sources, []).sort(), ['delete-own-message']);
    assert.deepEqual(grantedPermissions(sources, ['owner']).sort(), [
      'delete-own-message',
      'force-delete-message',
      'pin-message',
    ]);
  });

  test('rolesDuSalon lit la colonne, et ne lève jamais', () => {
    assert.deepEqual(roomRoles('["owner","moderator"]'), ['owner', 'moderator']);
    assert.deepEqual(roomRoles(null), []);
    assert.deepEqual(roomRoles('{pas du json'), []);
    assert.deepEqual(roomRoles('"owner"'), []);
  });

  test('une lecture par compte, et un échec n’est pas retenu', async () => {
    const { client, appels } = fauxClient(1);
    await assert.rejects(sourcesPermissions(client));
    await sourcesPermissions(client);
    await sourcesPermissions(client);
    assert.equal(appels.filter((a) => a === 'permissions.listAll').length, 2);
  });
});
