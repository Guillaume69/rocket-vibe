import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ClientRest } from '../../lib/rest.ts';
import { ActionsRC } from './actions.ts';

/** Faux client : on observe le endpoint et le corps de chaque `post`. */
function fauxClient(reponse: unknown = {}) {
  const appels: { chemin: string; corps: unknown }[] = [];
  const client = {
    post: async (chemin: string, options: { corps?: unknown } = {}) => {
      appels.push({ chemin, corps: options.corps });
      return reponse;
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

  test('ouvrirOuCreerDm rend le rid ET le document brut à ingérer', async () => {
    const salon = { _id: 'dm1', t: 'd' };
    const { client, appels } = fauxClient({ room: salon });
    const resultat = await new ActionsRC(client).ouvrirOuCreerDm('lea');
    assert.deepEqual(appels, [{ chemin: 'im.create', corps: { username: 'lea' } }]);
    assert.deepEqual(resultat, { rid: 'dm1', salonBrut: salon });
  });

  test('ouvrirOuCreerDm rejette un 200 sans salon exploitable', async () => {
    // Réponse sans `room`, puis `room` sans `_id` : les deux formes anormales.
    await assert.rejects(new ActionsRC(fauxClient({}).client).ouvrirOuCreerDm('lea'));
    await assert.rejects(
      new ActionsRC(fauxClient({ room: { t: 'd' } }).client).ouvrirOuCreerDm('lea'),
    );
  });
});
