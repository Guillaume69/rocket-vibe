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
  test('infosSalon preserves the official rooms.info route and neutral fields',async()=>{
    const calls:unknown[]=[];
    const client={get:async(path:string,options:unknown)=>{calls.push([path,options]);return {room:{_id:'r1',name:'room',fname:'A room',t:'p',description:'Description',topic:'Sujet',announcement:'Annonce',usersCount:4,ro:true}};}} as unknown as ClientRest;
    assert.deepEqual(await new ActionsRC(client).infosSalon('r1'),{id:'r1',nom:'A room',type:'p',description:'Description',sujet:'Sujet',annonce:'Annonce',membres:4,lectureSeule:true});
    assert.deepEqual(calls,[['rooms.info',{params:{roomId:'r1'}}]]);
  });
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

  test('modifier un message chiffré envoie `content` et les mentions, jamais `text`', async () => {
    const { client, appels } = fauxClient();
    const contenu = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'aXY=', ciphertext: 'Y3Q=' };
    await new ActionsRC(client).modifier('r1', 'm1', 'salut @bob', { chiffrer: () => contenu });
    assert.deepEqual(appels, [
      {
        chemin: 'chat.update',
        corps: {
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
    await assert.rejects(new ActionsRC(client).modifier('r1', 'm1', 'x', { chiffrer: () => null }));
    assert.equal(appels.length, 0);
  });

  test('epingler et marquerLu', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.epingler('r1', 'm1');
    await a.marquerLu('r1');
    assert.deepEqual(appels[0], { chemin: 'chat.pinMessage', corps: { messageId: 'm1' } });
    assert.deepEqual(appels[1], { chemin: 'subscriptions.read', corps: { rid: 'r1' } });
  });

  test('desepingler et etoiler (poser, retirer)', async () => {
    const { client, appels } = fauxClient();
    const a = new ActionsRC(client);
    await a.desepingler('r1', 'm1');
    await a.etoiler('r1', 'm1', true);
    await a.etoiler('r1', 'm1', false);
    assert.deepEqual(appels, [
      { chemin: 'chat.unPinMessage', corps: { messageId: 'm1' } },
      { chemin: 'chat.starMessage', corps: { messageId: 'm1' } },
      { chemin: 'chat.unStarMessage', corps: { messageId: 'm1' } },
    ]);
  });

  test('listerEpingles / listerEtoiles : un GET par liste, normalisé, le plus récent en tête', async () => {
    const lus: { chemin: string; params: unknown }[] = [];
    const u = { _id: 'u1', username: 'alice' };
    const client = {
      get: async (chemin: string, options: { params?: unknown } = {}) => {
        lus.push({ chemin, params: options.params });
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
    const epingles = await a.listerEpingles('r1');
    await a.listerEtoiles('r1');
    assert.deepEqual(
      epingles.map((m) => [m.id, m.texte, m.epingle]),
      [
        ['b', 'récent', true],
        ['a', 'vieux', true],
      ],
    );
    assert.deepEqual(lus, [
      { chemin: 'chat.getPinnedMessages', params: { roomId: 'r1', count: 50 } },
      { chemin: 'chat.getStarredMessages', params: { roomId: 'r1', count: 50 } },
    ]);
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
