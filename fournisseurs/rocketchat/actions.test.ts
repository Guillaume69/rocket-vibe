import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ClientRest } from '../../lib/rest.ts';
import { ActionsRC } from './actions.ts';

/** Faux client : on observe le endpoint et le corps de chaque `post`. */
function fauxClient() {
  const appels: { chemin: string; corps: unknown }[] = [];
  const client = {
    post: async (chemin: string, options: { corps?: unknown } = {}) => {
      appels.push({ chemin, corps: options.corps });
      return {} as unknown;
    },
  } as unknown as ClientRest;
  return { client, appels };
}

describe('ActionsRC', () => {
  test('reagir enveloppe le shortname en :code: et passe shouldReact', async () => {
    const { client, appels } = fauxClient();
    await new ActionsRC(client).reagir('r1', 'm1', '+1', true);
    assert.deepEqual(appels, [
      { chemin: 'chat.react', corps: { messageId: 'm1', emoji: ':+1:', shouldReact: true } },
    ]);
  });

  test('modifier et supprimer ciblent roomId + msgId', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.modifier('r1', 'm1', 'salut');
    await a.supprimer('r1', 'm1');
    assert.deepEqual(appels[0], {
      chemin: 'chat.update',
      corps: { roomId: 'r1', msgId: 'm1', text: 'salut' },
    });
    assert.deepEqual(appels[1], { chemin: 'chat.delete', corps: { roomId: 'r1', msgId: 'm1' } });
  });

  test('epingler et marquerLu', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.epingler('r1', 'm1');
    await a.marquerLu('r1');
    assert.deepEqual(appels[0], { chemin: 'chat.pinMessage', corps: { messageId: 'm1' } });
    assert.deepEqual(appels[1], { chemin: 'subscriptions.read', corps: { rid: 'r1' } });
  });
});
