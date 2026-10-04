import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PRESENCE_EVENT, PresenceEngine, STREAM_NOTIFY_LOGGED } from './presence.ts';
import { ClientRest } from './rest.ts';

const event = (args: unknown[]) => ({
  collection: STREAM_NOTIFY_LOGGED,
  eventKey: PRESENCE_EVENT,
  args,
});

/** Client REST réel, fetch simulé — on éprouve l'URL réellement construite. */
function fakeClient(reply: (url: string) => unknown) {
  const urls: string[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const body = reply(String(url));
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

describe('MoteurPresence — stream', () => {
  test('un événement user-status met à jour le statut et notifie', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event([['u1', 'bob', 3, '']]));
    assert.equal(engine.statusOf('u1'), 'busy');
    assert.equal(notifications, 1);

    engine.apply(event([['u1', 'bob', 0, '']]));
    assert.equal(engine.statusOf('u1'), 'offline');
  });

  test('collection ou clé étrangère, numéro inconnu, uid vide : ignorés sans bruit', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply({ collection: 'stream-room-messages', eventKey: 'r1', args: [{}] });
    engine.apply({
      collection: STREAM_NOTIFY_LOGGED,
      eventKey: 'updateCustomUserStatus',
      args: [{}],
    });
    engine.apply(event([['u1', 'bob', 42, '']]));
    engine.apply(event([['', 'bob', 1, '']]));
    engine.apply(event(['pas-un-tableau']));

    assert.equal(engine.statusOf('u1'), null);
    assert.equal(notifications, 0);
  });
});

describe('MoteurPresence — users.presence', () => {
  test('photo complète, JAMAIS de from (curseur d’horloge locale interdit)', async () => {
    const engine = new PresenceEngine();
    const { client, urls } = fakeClient(() => ({
      users: [
        { _id: 'u1', status: 'online' },
        { _id: 'u2', status: 'busy' },
      ],
      full: true,
    }));

    await engine.load(client);
    await engine.load(client);
    assert.ok(urls.every((u) => !u.includes('from=')));
    assert.equal(engine.statusOf('u1'), 'online');
    assert.equal(engine.statusOf('u2'), 'busy');
  });

  test('un uid CONNU absent de la photo passe offline — les inconnus restent inconnus', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    const { client } = fakeClient(() => ({ users: [{ _id: 'u2', status: 'away' }], full: true }));

    await engine.load(client);
    assert.equal(engine.statusOf('u1'), 'offline', 'la photo n’inclut que les non-offline');
    assert.equal(engine.statusOf('u2'), 'away');
    assert.equal(engine.statusOf('u3'), null, 'jamais vu : toujours inconnu');
  });

  test('un événement STREAM arrivé pendant la requête gagne sur la photo', async () => {
    const engine = new PresenceEngine();
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'online' }] }));
    // On intercale l'événement entre le départ de la requête et sa réponse :
    // le faux fetch est synchrone, on passe par une promesse de contrôle.
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve(); // laisse `unePhoto` prendre son seuil et partir
    engine.apply(event([['u1', 'bob', 0, '']])); // offline, PLUS FRAIS
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), 'offline', 'la photo (antérieure) ne régresse pas u1');
  });

  test('échec REST : silencieux, l’état connu survit (dégradation gracieuse)', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    const { client } = fakeClient(() => new TypeError('Network request failed'));

    await engine.load(client); // ne doit pas jeter
    assert.equal(engine.statusOf('u1'), 'online');
  });
});

describe('MoteurPresence — invalidation', () => {
  test('invalider rend TOUT inconnu et notifie', () => {
    // Le contrat de l'en-tête du module : « une présence périmée affichée
    // depuis un cache est pire que pas de présence du tout ». Il n'était tenu
    // que contre la persistance ; en mémoire, la pastille verte d'avant le
    // tunnel restait affichée jusqu'au raccordement suivant.
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    engine.apply(event([['u2', 'ana', 2, '']]));
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.invalidate();

    assert.equal(engine.statusOf('u1'), null, 'l’UI n’affiche plus rien, au lieu de mentir');
    assert.equal(engine.statusOf('u2'), null);
    assert.equal(notifications, 1, 'les écrans montés doivent se redessiner');
  });

  test('invalider sans rien à oublier ne réveille pas les écrans', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);
    engine.invalidate();
    engine.invalidate();
    assert.equal(notifications, 0, 'un flap réseau sur une app muette ne redessine rien');
  });

  test('une photo PARTIE avant l’invalidation ne ressuscite pas les statuts effacés', async () => {
    // Course réelle : la socket meurt pendant que `users.presence` est en vol.
    // Sa réponse décrit le monde d'AVANT la coupure — l'appliquer remettrait
    // exactement les pastilles que l'invalidation venait d'éteindre.
    const engine = new PresenceEngine();
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({
      users: [
        { _id: 'u1', status: 'online' },
        { _id: 'u2', status: 'away' },
      ],
    }));
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve(); // la requête est partie
    engine.invalidate(); // le transport meurt
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), null, 'la photo d’avant la coupure est jetée');
    assert.equal(engine.statusOf('u2'), null);
  });

  test('après invalidation, une NOUVELLE photo repeuple normalement', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    engine.invalidate();
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'away' }] }));

    await engine.load(client);
    assert.equal(engine.statusOf('u1'), 'away');
  });

  test('un événement STREAM postérieur à l’invalidation gagne sur la photo en vol', async () => {
    // Le compteur de séquence doit rester MONOTONE à travers l'invalidation :
    // le remettre à zéro ferait repasser un événement frais pour antérieur au
    // seuil pris par la photo, et la photo l'écraserait.
    const engine = new PresenceEngine();
    for (let i = 0; i < 5; i++) engine.apply(event([[`u${i}`, 'x', 1, '']]));
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'online' }] }));
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve();
    engine.invalidate();
    engine.apply(event([['u1', 'bob', 0, '']])); // reçu APRÈS, donc vrai
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), 'offline');
  });
});
