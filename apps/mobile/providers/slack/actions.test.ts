import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SlackActions, reactionName } from './actions.ts';
import { SlackClient, SlackError } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { COOKIE, TOKEN, fakeSlack, type SlackAnswer, type SlackCall } from './testing.ts';
import { markdownToMrkdwn } from './translator.ts';

function setup(route: (call: SlackCall) => SlackAnswer | undefined = () => ({ body: { ok: true } })) {
  const server = fakeSlack(route);
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const history = new SlackHistory(client, directory);
  const live = new SlackLive({ client, directory, history, myId: 'U000' });
  live.remember({ id: 'C001', name: 'general' }, { id: 'C001', latest: '1780000000.000500' });
  return { actions: new SlackActions({ client, directory, history, live }), server };
}

const MID = 'C001:1780000000.000100';

describe('SlackActions', () => {
  test('edit and delete target the exact channel and ts', async () => {
    const { actions, server } = setup();
    await actions.edit('C001', MID, '~~old~~ new');
    await actions.delete('C001', MID);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.channel, c.args.ts]), [
      ['chat.update', 'C001', '1780000000.000100'],
      ['chat.delete', 'C001', '1780000000.000100'],
    ]);
    assert.equal(server.calls[0]!.args.text, '~old~ new');
  });

  test('a message of another room is refused before any request', async () => {
    const { actions, server } = setup();
    await assert.rejects(actions.edit('C002', MID, 'x'), (e) => e instanceof SlackError && e.code === 'message_not_found');
    assert.equal(server.calls.length, 0);
  });

  test('a reaction goes by bare name; the state already there settles it', async () => {
    const { actions, server } = setup((call) => ({ body: call.method === 'reactions.remove' ? { ok: false, error: 'no_reaction' } : { ok: true } }));
    await actions.react('C001', MID, ':+1:', true);
    await actions.react('C001', MID, 'tada', false);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.name, c.args.timestamp]), [
      ['reactions.add', '+1', '1780000000.000100'],
      ['reactions.remove', 'tada', '1780000000.000100'],
    ]);
  });

  test('mark read goes to the message shown, else the newest known, and never backwards', async () => {
    const { actions, server } = setup();
    await actions.markRead('C001');
    await actions.markRead('C001', { messageId: MID, adhesion: '' });
    await actions.markRead('C001');
    assert.deepEqual(server.calls.map((c) => c.args.ts), ['1780000000.000500']);
  });

  test('pins and DMs still refuse', async () => {
    const { actions } = setup();
    await assert.rejects(actions.pin('C001', MID), (e) => e instanceof SlackError && e.code === 'unsupported');
    await assert.rejects(actions.openOrCreateDm('alice'), SlackError);
  });
});

describe('reactionName', () => {
  test('strips the shortcode colons', () => {
    assert.equal(reactionName(':thumbsup:'), 'thumbsup');
    assert.equal(reactionName('eyes'), 'eyes');
  });
});

describe('markdownToMrkdwn', () => {
  const idOf = (u: string) => (u === 'alice' ? 'U001' : null);
  test('bold, italic, strike, links and mentions', () => {
    assert.equal(markdownToMrkdwn('**b** *i* ~~s~~', idOf), '*b* _i_ ~s~');
    assert.equal(markdownToMrkdwn('see [docs](https://x.test/a) @alice @bob @here @all', idOf), 'see <https://x.test/a|docs> <@U001> @bob <!here> <!channel>');
  });
  test('code is left as typed, and Slack entities are escaped outside it', () => {
    assert.equal(markdownToMrkdwn('a < b & `<@x> **y**`', idOf), 'a &lt; b &amp; `<@x> **y**`');
    assert.equal(markdownToMrkdwn('mail me@alice.test, thanks @alice.', idOf), 'mail me@alice.test, thanks <@U001>.');
    assert.equal(markdownToMrkdwn('2*3*4 stays', idOf), '2*3*4 stays');
  });
});
