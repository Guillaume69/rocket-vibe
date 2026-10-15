import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { searchSlackMessages } from './search.ts';
import { COOKIE, TOKEN, fakeSlack } from './testing.ts';
import { SlackTranslator } from './translator.ts';

test("a room's search is scoped by in:<#channel> and its matches translated as messages", async () => {
  const match = (ts: string, channel: string, text: string) => ({
    type: 'message', ts, user: 'U001', username: 'alice', text, channel: { id: channel, name: 'general' }, permalink: `https://test.slack.com/archives/${channel}/p${ts.replace('.', '')}`,
  });
  const server = fakeSlack((call) => (call.method === 'search.messages'
    ? { body: { ok: true, messages: { total: 3, matches: [match('1780000000.000300', 'C001', 'deploy *now*'), match('1780000000.000200', 'C002', 'deploy'), match('1780000000.000100', 'C001', 'deploy later')] } } }
    : undefined));
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const history = new SlackHistory(client, directory);
  const translator = new SlackTranslator(directory, 'U000');
  const found = await searchSlackMessages({ client, history, translator }, 'C001', 'deploy');
  assert.deepEqual(server.calls.map((c) => [c.method, c.args.query, c.args.count]), [['search.messages', 'deploy in:<#C001>', '100']]);
  assert.deepEqual(found.map((m) => [m.id, m.rid, m.text, m.authorName]), [
    ['C001:1780000000.000300', 'C001', 'deploy **now**', 'alice'],
    ['C001:1780000000.000100', 'C001', 'deploy later', 'alice'],
  ]);
});
