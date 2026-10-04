import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completeCommand,
  splitCommand,
  detectCommandToken,
  runCommand,
  readCommands,
  privateMessage,
  words,
} from './commands.ts';

const LIST = {
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
    const c = readCommands(LIST, 'en');
    assert.equal(c.length, 4);
    assert.equal(c[0]!.params, 'your message (optional)');
    assert.equal(c[0]!.description, 'Puts ¯\\_(ツ)_/¯ after your message');
    assert.equal(c[1]!.params, '@username');
    assert.deepEqual(c[1]!.permissions, ['remove-user']);
    assert.deepEqual(c[2]!.permissions, ['leave-c', 'leave-p']);
    assert.equal(c[3]!.description, 'Poll App Create Poll');
    assert.equal(c[3]!.params, 'question');
  });

  test('en français', () => {
    assert.equal(readCommands(LIST, 'fr')[1]!.description, "Retirer quelqu'un du salon");
    assert.equal(words('Slash_Topic_Params', 'fr'), 'sujet');
  });

  test('une réponse sans liste ne donne rien', () => {
    assert.deepEqual(readCommands(null, 'en'), []);
    assert.deepEqual(readCommands({ commands: 'non' }, 'en'), []);
  });
});

describe('detecterJetonCommande', () => {
  test('propose tant que le premier mot est en cours', () => {
    assert.deepEqual(detectCommandToken('/', 1), { query: '' });
    assert.deepEqual(detectCommandToken('/sh', 3), { query: 'sh' });
    assert.equal(detectCommandToken('/shrug ', 7), null);
    assert.equal(detectCommandToken('salut /sh', 9), null);
    assert.equal(detectCommandToken(' /sh', 4), null);
    assert.equal(detectCommandToken('/usr/bin', 8), null);
    assert.deepEqual(detectCommandToken('/shrug lol', 3), { query: 'sh' });
  });
});

describe('completerCommande', () => {
  const commands = readCommands(LIST, 'en');
  const names = (c: { name: string }[]) => c.map((x) => x.name);

  test('triées par nom, filtrées par préfixe', () => {
    assert.deepEqual(names(completeCommand(commands, '', null)), ['kick', 'leave', 'poll', 'shrug']);
    assert.deepEqual(names(completeCommand(commands, 'K', null)), ['kick']);
    assert.equal(completeCommand(commands, '', null, 2).length, 2);
  });

  test('seulement celles que je peux lancer, quand on le sait', () => {
    assert.deepEqual(names(completeCommand(commands, '', ['leave-p'])), ['leave', 'poll', 'shrug']);
  });
});

describe('decouperCommande', () => {
  test('sépare le nom de ses paramètres', () => {
    assert.deepEqual(splitCommand('/shrug'), { name: 'shrug', params: '' });
    assert.deepEqual(splitCommand('/me  salue \n tout le monde '), {
      name: 'me',
      params: 'salue \n tout le monde',
    });
    assert.deepEqual(splitCommand('  /topic nouveau'), { name: 'topic', params: 'nouveau' });
    assert.equal(splitCommand('/'), null);
    assert.equal(splitCommand('/usr/bin est un chemin'), null);
    assert.equal(splitCommand('pas /une commande'), null);
  });
});

describe('messagePrive', () => {
  test('porte son salon', () => {
    const args = [{ _id: '1', rid: 'R1', msg: 'The channel `#nope` does not exist.', private: true }];
    assert.deepEqual(privateMessage(args), { rid: 'R1', text: 'The channel `#nope` does not exist.' });
    assert.equal(privateMessage([{ rid: 'R1', msg: '  ' }]), null);
    assert.equal(privateMessage([{ msg: 'sans salon' }]), null);
    assert.equal(privateMessage([]), null);
  });
});

describe('lancerCommande', () => {
  function fakeClient() {
    const posts: { path: string; body: unknown }[] = [];
    let user = 0;
    const client = {
      baseUrl: 'http://x',
      auth: { userId: `u${++user}-${Math.random()}`, authToken: 't' },
      get: async <T>(): Promise<T> => LIST as T,
      post: async <T>(path: string, options: { body?: unknown } = {}): Promise<T> => {
        posts.push({ path, body: options.body });
        return { success: true } as T;
      },
    };
    return { client, posts };
  }

  test('lance une commande connue, dans le fil le cas échéant', async () => {
    const { client, posts } = fakeClient();
    assert.equal(await runCommand(client, 'R1', '/shrug lol', 'F1'), true);
    assert.equal(posts.length, 1);
    const body = posts[0]!.body as Record<string, string>;
    assert.equal(posts[0]!.path, 'commands.run');
    assert.equal(body.command, 'shrug');
    assert.equal(body.params, 'lol');
    assert.equal(body.roomId, 'R1');
    assert.equal(body.tmid, 'F1');
    assert.ok(body.triggerId !== undefined && body.triggerId.length > 0);
  });

  test('un nom inconnu ou du texte reste un message', async () => {
    const { client, posts } = fakeClient();
    assert.equal(await runCommand(client, 'R1', '/inconnue', null), false);
    assert.equal(await runCommand(client, 'R1', 'bonjour', null), false);
    assert.equal(posts.length, 0);
  });

  test('un refus du serveur remonte', async () => {
    const { client } = fakeClient();
    client.post = async () => {
      throw new Error('refusée');
    };
    await assert.rejects(runCommand(client, 'R1', '/kick @bob', null), /refusée/);
  });
});
