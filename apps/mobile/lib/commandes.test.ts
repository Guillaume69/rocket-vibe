import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completerCommande,
  decouperCommande,
  detecterJetonCommande,
  lancerCommande,
  lireCommandes,
  messagePrive,
  mots,
} from './commandes.ts';

const LISTE = {
  commands: [
    { command: 'shrug', params: 'your_message_optional', description: 'Slash_Shrug_Description', clientOnly: true },
    { command: 'kick', params: '@username', description: 'Remove_someone_from_room', permission: 'remove-user' },
    { command: 'leave', description: 'Leave_the_current_channel', permission: ['leave-c', 'leave-p'] },
    { command: 'poll', params: 'question', description: 'Poll_App_Create_Poll' },
    { command: '', description: 'sans nom' },
  ],
};

describe('lireCommandes', () => {
  test('lit la liste et met ses clés en mots', () => {
    const c = lireCommandes(LISTE, 'en');
    assert.equal(c.length, 4);
    assert.equal(c[0]!.parametres, 'your message (optional)');
    assert.equal(c[0]!.description, 'Puts ¯\\_(ツ)_/¯ after your message');
    assert.equal(c[1]!.parametres, '@username');
    assert.deepEqual(c[1]!.permissions, ['remove-user']);
    assert.deepEqual(c[2]!.permissions, ['leave-c', 'leave-p']);
    assert.equal(c[3]!.description, 'Poll App Create Poll');
    assert.equal(c[3]!.parametres, 'question');
  });

  test('en français', () => {
    assert.equal(lireCommandes(LISTE, 'fr')[1]!.description, "Retirer quelqu'un du salon");
    assert.equal(mots('Slash_Topic_Params', 'fr'), 'sujet');
  });

  test('une réponse sans liste ne donne rien', () => {
    assert.deepEqual(lireCommandes(null, 'en'), []);
    assert.deepEqual(lireCommandes({ commands: 'non' }, 'en'), []);
  });
});

describe('detecterJetonCommande', () => {
  test('propose tant que le premier mot est en cours', () => {
    assert.deepEqual(detecterJetonCommande('/', 1), { requete: '' });
    assert.deepEqual(detecterJetonCommande('/sh', 3), { requete: 'sh' });
    assert.equal(detecterJetonCommande('/shrug ', 7), null);
    assert.equal(detecterJetonCommande('salut /sh', 9), null);
    assert.equal(detecterJetonCommande(' /sh', 4), null);
    assert.equal(detecterJetonCommande('/usr/bin', 8), null);
    assert.deepEqual(detecterJetonCommande('/shrug lol', 3), { requete: 'sh' });
  });
});

describe('completerCommande', () => {
  const commandes = lireCommandes(LISTE, 'en');
  const noms = (c: { nom: string }[]) => c.map((x) => x.nom);

  test('triées par nom, filtrées par préfixe', () => {
    assert.deepEqual(noms(completerCommande(commandes, '', null)), ['kick', 'leave', 'poll', 'shrug']);
    assert.deepEqual(noms(completerCommande(commandes, 'K', null)), ['kick']);
    assert.equal(completerCommande(commandes, '', null, 2).length, 2);
  });

  test('seulement celles que je peux lancer, quand on le sait', () => {
    assert.deepEqual(noms(completerCommande(commandes, '', ['leave-p'])), ['leave', 'poll', 'shrug']);
  });
});

describe('decouperCommande', () => {
  test('sépare le nom de ses paramètres', () => {
    assert.deepEqual(decouperCommande('/shrug'), { nom: 'shrug', parametres: '' });
    assert.deepEqual(decouperCommande('/me  salue \n tout le monde '), {
      nom: 'me',
      parametres: 'salue \n tout le monde',
    });
    assert.deepEqual(decouperCommande('  /topic nouveau'), { nom: 'topic', parametres: 'nouveau' });
    assert.equal(decouperCommande('/'), null);
    assert.equal(decouperCommande('/usr/bin est un chemin'), null);
    assert.equal(decouperCommande('pas /une commande'), null);
  });
});

describe('messagePrive', () => {
  test('porte son salon', () => {
    const args = [{ _id: '1', rid: 'R1', msg: 'The channel `#nope` does not exist.', private: true }];
    assert.deepEqual(messagePrive(args), { rid: 'R1', texte: 'The channel `#nope` does not exist.' });
    assert.equal(messagePrive([{ rid: 'R1', msg: '  ' }]), null);
    assert.equal(messagePrive([{ msg: 'sans salon' }]), null);
    assert.equal(messagePrive([]), null);
  });
});

describe('lancerCommande', () => {
  function fauxClient() {
    const posts: { chemin: string; corps: unknown }[] = [];
    let utilisateur = 0;
    const client = {
      baseUrl: 'http://x',
      identifiants: { userId: `u${++utilisateur}-${Math.random()}`, authToken: 't' },
      get: async <T>(): Promise<T> => LISTE as T,
      post: async <T>(chemin: string, options: { corps?: unknown } = {}): Promise<T> => {
        posts.push({ chemin, corps: options.corps });
        return { success: true } as T;
      },
    };
    return { client, posts };
  }

  test('lance une commande connue, dans le fil le cas échéant', async () => {
    const { client, posts } = fauxClient();
    assert.equal(await lancerCommande(client, 'R1', '/shrug lol', 'F1'), true);
    assert.equal(posts.length, 1);
    const corps = posts[0]!.corps as Record<string, string>;
    assert.equal(posts[0]!.chemin, 'commands.run');
    assert.equal(corps.command, 'shrug');
    assert.equal(corps.params, 'lol');
    assert.equal(corps.roomId, 'R1');
    assert.equal(corps.tmid, 'F1');
    assert.ok(corps.triggerId !== undefined && corps.triggerId.length > 0);
  });

  test('un nom inconnu ou du texte reste un message', async () => {
    const { client, posts } = fauxClient();
    assert.equal(await lancerCommande(client, 'R1', '/inconnue', null), false);
    assert.equal(await lancerCommande(client, 'R1', 'bonjour', null), false);
    assert.equal(posts.length, 0);
  });

  test('un refus du serveur remonte', async () => {
    const { client } = fauxClient();
    client.post = async () => {
      throw new Error('refusée');
    };
    await assert.rejects(lancerCommande(client, 'R1', '/kick @bob', null), /refusée/);
  });
});
