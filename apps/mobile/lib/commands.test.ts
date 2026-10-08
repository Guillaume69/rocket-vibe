import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  commandErrorKey,
  completeCommand,
  splitCommand,
  detectCommandToken,
  runCommand,
  readCommands,
  privateMessage,
  textCommand,
  words,
} from './commands.ts';

const LIST = {
  commands: [
    { command: 'shrug', params: 'your_message_optional', description: 'Slash_Shrug_Description', clientOnly: true },
    { command: 'kick', params: '@username', description: 'Remove_someone_from_room', permission: 'remove-user' },
    { command: 'leave', description: 'Leave_the_current_channel', permission: ['leave-c', 'leave-p'] },
    { command: 'poll', params: 'question', description: 'Poll_App_Create_Poll' },
    { command: '', description: 'unnamed' },
  ],
};

describe('readCommands', () => {
  test('reads the list and puts its keys into words', () => {
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

  test('in French', () => {
    assert.equal(readCommands(LIST, 'fr')[1]!.description, "Retirer quelqu'un du salon");
    assert.equal(words('Slash_Topic_Params', 'fr'), 'sujet');
    assert.equal(words('app-8b88-42.GIPHY_Search_Term', 'en'), 'GIPHY Search Term');
  });

  test('a RocketVibe list keeps the core wording and shows a workflow command as sent', () => {
    const native = {
      commands: [
        { command: 'shrug', params: 'your_message_optional', description: 'Slash_Shrug_Description', client_side: true },
        { command: 'standup', params: '', description: 'Daily_Standup of the team', client_side: false },
        { command: 'deploy', params: '', description: 'Deploy_App', client_side: false },
      ],
    };
    const c = readCommands(native, 'en', true);
    assert.equal(c[0]!.description, 'Puts ¯\\_(ツ)_/¯ after your message');
    assert.equal(c[1]!.description, 'Daily_Standup of the team');
    assert.equal(c[2]!.description, 'Deploy_App');
    assert.equal(readCommands(native, 'en')[2]!.description, 'Deploy App');
  });

  test('a response without a list yields nothing', () => {
    assert.deepEqual(readCommands(null, 'en'), []);
    assert.deepEqual(readCommands({ commands: 'no' }, 'en'), []);
  });
});

describe('detectCommandToken', () => {
  test('suggests while the first word is being typed', () => {
    assert.deepEqual(detectCommandToken('/', 1), { query: '' });
    assert.deepEqual(detectCommandToken('/sh', 3), { query: 'sh' });
    assert.equal(detectCommandToken('/shrug ', 7), null);
    assert.equal(detectCommandToken('hello /sh', 9), null);
    assert.equal(detectCommandToken(' /sh', 4), null);
    assert.equal(detectCommandToken('/usr/bin', 8), null);
    assert.deepEqual(detectCommandToken('/shrug lol', 3), { query: 'sh' });
  });
});

describe('completeCommand', () => {
  const commands = readCommands(LIST, 'en');
  const names = (c: { name: string }[]) => c.map((x) => x.name);

  test('sorted by name, filtered by prefix', () => {
    assert.deepEqual(names(completeCommand(commands, '', null)), ['kick', 'leave', 'poll', 'shrug']);
    assert.deepEqual(names(completeCommand(commands, 'K', null)), ['kick']);
    assert.equal(completeCommand(commands, '', null, 2).length, 2);
  });

  test('only those I can run, when known', () => {
    assert.deepEqual(names(completeCommand(commands, '', ['leave-p'])), ['leave', 'poll', 'shrug']);
  });
});

describe('splitCommand', () => {
  test('splits the name from its parameters', () => {
    assert.deepEqual(splitCommand('/shrug'), { name: 'shrug', params: '' });
    assert.deepEqual(splitCommand('/me  waves \n at everyone '), {
      name: 'me',
      params: 'waves \n at everyone',
    });
    assert.deepEqual(splitCommand('  /topic new'), { name: 'topic', params: 'new' });
    assert.equal(splitCommand('/'), null);
    assert.equal(splitCommand('/usr/bin is a path'), null);
    assert.equal(splitCommand('not /a command'), null);
  });
});

describe('privateMessage', () => {
  test('carries its room', () => {
    const args = [{ _id: '1', rid: 'R1', msg: 'The channel `#nope` does not exist.', private: true }];
    assert.deepEqual(privateMessage(args), { rid: 'R1', text: 'The channel `#nope` does not exist.' });
    assert.equal(privateMessage([{ rid: 'R1', msg: '  ' }]), null);
    assert.equal(privateMessage([{ msg: 'no room' }]), null);
    assert.equal(privateMessage([]), null);
  });
});

describe('runCommand', () => {
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

  test('runs a known command, in the thread if any', async () => {
    const { client, posts } = fakeClient();
    assert.deepEqual(await runCommand(client, 'R1', '/kick @bob', 'F1'), { kind: 'done' });
    assert.equal(posts.length, 1);
    const body = posts[0]!.body as Record<string, string>;
    assert.equal(posts[0]!.path, 'commands.run');
    assert.equal(body.command, 'kick');
    assert.equal(body.params, '@bob');
    assert.equal(body.roomId, 'R1');
    assert.equal(body.tmid, 'F1');
    assert.ok(body.triggerId !== undefined && body.triggerId.length > 0);
  });

  test('an unknown name or plain text stays a message', async () => {
    const { client, posts } = fakeClient();
    assert.equal(await runCommand(client, 'R1', '/unknown', null), null);
    assert.equal(await runCommand(client, 'R1', 'hello', null), null);
    assert.equal(posts.length, 0);
  });

  test('a text command is written here, never run by the server', async () => {
    const { client, posts } = fakeClient();
    assert.deepEqual(await runCommand(client, 'R1', '/shrug lol', null), { kind: 'message', text: 'lol ¯\\_(ツ)_/¯' });
    assert.equal(posts.length, 0);
  });

  test('a server refusal propagates', async () => {
    const { client } = fakeClient();
    client.post = async () => {
      throw new Error('refused');
    };
    await assert.rejects(runCommand(client, 'R1', '/kick @bob', null), /refused/);
  });
});

describe('textCommand', () => {
  test('writes what Rocket.Chat writes', () => {
    assert.deepEqual(textCommand('shrug', ''), { kind: 'message', text: '¯\\_(ツ)_/¯' });
    assert.deepEqual(textCommand('gimme', ' coffee '), { kind: 'message', text: '༼ つ ◕_◕ ༽つ coffee' });
    assert.deepEqual(textCommand('tableflip', 'argh'), { kind: 'message', text: 'argh (╯°□°）╯︵ ┻━┻' });
    assert.deepEqual(textCommand('me', 'waves'), { kind: 'message', text: '_waves_' });
    assert.deepEqual(textCommand('me', '  '), { kind: 'done' });
    assert.equal(textCommand('topic', 'x'), null);
  });
});

test('a workflow command refused as it starts is worded', () => {
  assert.equal(commandErrorKey('workflow_unavailable'), 'command.workflowUnavailable');
  assert.equal(commandErrorKey('workflow_rate_limited'), 'command.workflowRate');
  assert.equal(commandErrorKey('workflow_busy'), 'command.workflowBusy');
  assert.equal(commandErrorKey('unknown_command'), 'command.notFound');
  assert.equal(commandErrorKey('something_else'), null);
});
