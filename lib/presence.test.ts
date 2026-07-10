import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EVENEMENT_PRESENCE, MoteurPresence, STREAM_NOTIFY_LOGGED } from './presence.ts';
import { ClientRest } from './rest.ts';

const evenement = (args: unknown[]) => ({
  collection: STREAM_NOTIFY_LOGGED,
  cleEvenement: EVENEMENT_PRESENCE,
  args,
});

/** Client REST réel, fetch simulé — on éprouve l'URL réellement construite. */
function fauxClient(repondre: (url: string) => unknown) {
  const urls: string[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const corps = repondre(String(url));
      if (corps instanceof Error) throw corps;
      return new Response(JSON.stringify(corps), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
  return { client, urls };
}

describe('MoteurPresence — stream', () => {
  test('un événement user-status met à jour le statut et notifie', () => {
    const moteur = new MoteurPresence();
    let notifications = 0;
    moteur.surChangement(() => notifications++);

    moteur.appliquer(evenement([['u1', 'bob', 3, '']]));
    assert.equal(moteur.statutDe('u1'), 'busy');
    assert.equal(notifications, 1);

    moteur.appliquer(evenement([['u1', 'bob', 0, '']]));
    assert.equal(moteur.statutDe('u1'), 'offline');
  });

  test('collection ou clé étrangère, numéro inconnu, uid vide : ignorés sans bruit', () => {
    const moteur = new MoteurPresence();
    let notifications = 0;
    moteur.surChangement(() => notifications++);

    moteur.appliquer({ collection: 'stream-room-messages', cleEvenement: 'r1', args: [{}] });
    moteur.appliquer({
      collection: STREAM_NOTIFY_LOGGED,
      cleEvenement: 'updateCustomUserStatus',
      args: [{}],
    });
    moteur.appliquer(evenement([['u1', 'bob', 42, '']]));
    moteur.appliquer(evenement([['', 'bob', 1, '']]));
    moteur.appliquer(evenement(['pas-un-tableau']));

    assert.equal(moteur.statutDe('u1'), null);
    assert.equal(notifications, 0);
  });
});

describe('MoteurPresence — users.presence', () => {
  test('photo complète, JAMAIS de from (curseur d’horloge locale interdit)', async () => {
    const moteur = new MoteurPresence();
    const { client, urls } = fauxClient(() => ({
      users: [
        { _id: 'u1', status: 'online' },
        { _id: 'u2', status: 'busy' },
      ],
      full: true,
    }));

    await moteur.charger(client);
    await moteur.charger(client);
    assert.ok(urls.every((u) => !u.includes('from=')));
    assert.equal(moteur.statutDe('u1'), 'online');
    assert.equal(moteur.statutDe('u2'), 'busy');
  });

  test('un uid CONNU absent de la photo passe offline — les inconnus restent inconnus', async () => {
    const moteur = new MoteurPresence();
    moteur.appliquer(evenement([['u1', 'bob', 1, '']]));
    const { client } = fauxClient(() => ({ users: [{ _id: 'u2', status: 'away' }], full: true }));

    await moteur.charger(client);
    assert.equal(moteur.statutDe('u1'), 'offline', 'la photo n’inclut que les non-offline');
    assert.equal(moteur.statutDe('u2'), 'away');
    assert.equal(moteur.statutDe('u3'), null, 'jamais vu : toujours inconnu');
  });

  test('un événement STREAM arrivé pendant la requête gagne sur la photo', async () => {
    const moteur = new MoteurPresence();
    let livrer: () => void = () => {};
    const { client } = fauxClient(() => ({ users: [{ _id: 'u1', status: 'online' }] }));
    // On intercale l'événement entre le départ de la requête et sa réponse :
    // le faux fetch est synchrone, on passe par une promesse de contrôle.
    const clientLent = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          livrer = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const chargement = moteur.charger(clientLent);
    await Promise.resolve(); // laisse `unePhoto` prendre son seuil et partir
    moteur.appliquer(evenement([['u1', 'bob', 0, '']])); // offline, PLUS FRAIS
    livrer();
    await chargement;

    assert.equal(moteur.statutDe('u1'), 'offline', 'la photo (antérieure) ne régresse pas u1');
  });

  test('échec REST : silencieux, l’état connu survit (dégradation gracieuse)', async () => {
    const moteur = new MoteurPresence();
    moteur.appliquer(evenement([['u1', 'bob', 1, '']]));
    const { client } = fauxClient(() => new TypeError('Network request failed'));

    await moteur.charger(client); // ne doit pas jeter
    assert.equal(moteur.statutDe('u1'), 'online');
  });
});
