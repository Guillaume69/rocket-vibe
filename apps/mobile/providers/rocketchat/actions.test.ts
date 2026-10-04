import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ClientRest } from '../../lib/rest.ts';
import { ActionsRC } from './actions.ts';

/** Faux client : on observe le endpoint et le corps de chaque `post`. */
function fauxClient(reponse: unknown = {}) {
  const appels: { path: string; body: unknown }[] = [];
  const client = {
    post: async (chemin: string, options: { body?: unknown } = {}) => {
      appels.push({ path: chemin, body: options.body });
      return reponse;
    },
  } as unknown as ClientRest;
  return { client, appels };
}

describe('ActionsRC', () => {
  test('reagir enveloppe le shortname en :code: et passe shouldReact', async () => {
    const { client, appels } = fauxClient();
    await new ActionsRC(client).react('r1', 'm1', '+1', true);
    assert.deepEqual(appels, [
      { path: 'chat.react', body: { messageId: 'm1', emoji: ':+1:', shouldReact: true } },
    ]);
  });

  test('modifier et supprimer ciblent roomId + msgId', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.edit('r1', 'm1', 'salut');
    await a.delete('r1', 'm1');
    assert.deepEqual(appels[0], {
      path: 'chat.update',
      body: { roomId: 'r1', msgId: 'm1', text: 'salut' },
    });
    assert.deepEqual(appels[1], { path: 'chat.delete', body: { roomId: 'r1', msgId: 'm1' } });
  });

  test('modifier un message chiffré envoie `content` et les mentions, jamais `text`', async () => {
    const { client, appels } = fauxClient();
    const contenu = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'aXY=', ciphertext: 'Y3Q=' };
    await new ActionsRC(client).edit('r1', 'm1', 'salut @bob', { encrypt: () => contenu });
    assert.deepEqual(appels, [
      {
        path: 'chat.update',
        body: {
          roomId: 'r1',
          msgId: 'm1',
          content: contenu,
          e2eMentions: { e2eUserMentions: ['@bob'], e2eChannelMentions: [] },
        },
      },
    ]);
  });

  test('modifier un message chiffré sans clé échoue sans rien envoyer', async () => {
    const { client, appels } = fauxClient();
    await assert.rejects(new ActionsRC(client).edit('r1', 'm1', 'x', { encrypt: () => null }));
    assert.equal(appels.length, 0);
  });

  test('epingler et marquerLu', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.pin('r1', 'm1');
    await a.markRead('r1');
    assert.deepEqual(appels[0], { path: 'chat.pinMessage', body: { messageId: 'm1' } });
    assert.deepEqual(appels[1], { path: 'subscriptions.read', body: { rid: 'r1' } });
  });

  test('desepingler et etoiler (poser, retirer)', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.unpin('r1', 'm1');
    await a.star('r1', 'm1', true);
    await a.star('r1', 'm1', false);
    assert.deepEqual(appels, [
      { path: 'chat.unPinMessage', body: { messageId: 'm1' } },
      { path: 'chat.starMessage', body: { messageId: 'm1' } },
      { path: 'chat.unStarMessage', body: { messageId: 'm1' } },
    ]);
  });

  test('listerEpingles / listerEtoiles : un GET par liste, normalisé, le plus récent en tête', async () => {
    const lus: { path: string; params: unknown }[] = [];
    const u = { _id: 'u1', username: 'alice' };
    const client = {
      get: async (chemin: string, options: { params?: unknown } = {}) => {
        lus.push({ path: chemin, params: options.params });
        return {
          messages: [
            { _id: 'a', rid: 'r1', ts: '2026-01-01T00:00:00.000Z', msg: 'vieux', u, pinned: true },
            { _id: 'illisible' },
            { _id: 'b', rid: 'r1', ts: '2026-02-01T00:00:00.000Z', msg: 'récent', u, pinned: true },
          ],
        };
      },
    } as unknown as ClientRest;
    const a = new ActionsRC(client);
    const epingles = await a.listPinned('r1');
    await a.listStarred('r1');
    assert.deepEqual(
      epingles.map((m) => [m.id, m.text, m.pinned]),
      [
        ['b', 'récent', true],
        ['a', 'vieux', true],
      ],
    );
    assert.deepEqual(lus, [
      { path: 'chat.getPinnedMessages', params: { roomId: 'r1', count: 50 } },
      { path: 'chat.getStarredMessages', params: { roomId: 'r1', count: 50 } },
    ]);
  });

  test('ouvrirOuCreerDm rend le rid ET le document brut à ingérer', async () => {
    const salon = { _id: 'dm1', t: 'd' };
    const { client, appels } = fauxClient({ room: salon });
    const resultat = await new ActionsRC(client).openOrCreateDm('lea');
    assert.deepEqual(appels, [{ path: 'im.create', body: { username: 'lea' } }]);
    assert.deepEqual(resultat, { rid: 'dm1', rawRoom: salon });
  });

  test('ouvrirOuCreerDm rejette un 200 sans salon exploitable', async () => {
    // Réponse sans `room`, puis `room` sans `_id` : les deux formes anormales.
    await assert.rejects(new ActionsRC(fauxClient({}).client).openOrCreateDm('lea'));
    await assert.rejects(
      new ActionsRC(fauxClient({ room: { t: 'd' } }).client).openOrCreateDm('lea'),
    );
  });
});
