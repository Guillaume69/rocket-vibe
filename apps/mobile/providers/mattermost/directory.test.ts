import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MmClient } from './client.ts';
import { MmDirectory, toMmUser } from './directory.ts';
import { fakeServer } from './testing.ts';

const bob = { id: 'u-bob', username: 'bob', first_name: 'Bob', last_name: 'Builder', nickname: 'bob' };

describe('MmDirectory names', () => {
  test("the account's name format decides, and moves every known name", () => {
    const d = new MmDirectory(new MmClient('http://x', 't'));
    d.remember(toMmUser(bob)!);
    assert.equal(d.user('u-bob')?.displayName, 'Bob Builder');
    assert.equal(d.setNameFormat('nickname_full_name'), true);
    assert.equal(d.user('u-bob')?.displayName, 'bob');
    d.setNameFormat('username');
    assert.equal(d.user('u-bob')?.displayName, null);
    assert.equal(d.setNameFormat('username'), false);
  });

  test('the custom status emoji, an object on kChat or JSON on Mattermost, until it expires', () => {
    const at = (status: unknown) => toMmUser({ ...bob, props: { customStatus: status } })?.statusEmoji;
    assert.equal(at({ emoji: 'palm_tree', expires_at: '2999-01-01T00:00:00Z' }), '🌴');
    assert.equal(at(JSON.stringify({ emoji: 'palm_tree' })), '🌴');
    assert.equal(at({ emoji: 'palm_tree', expires_at: '2001-01-01T00:00:00Z' }), null);
    assert.equal(at(''), null);
  });

  test("a cut username in a group's title does not lose the others", async () => {
    const server = fakeServer((call) => {
      const names = call.body as string[];
      if (names.includes('olivier.daumi')) return { status: 400, body: { id: 'app.user.get_by_usernames', message: 'bad', status_code: 400 } };
      return { body: names.map((n) => ({ id: `u-${n}`, username: n, first_name: n.toUpperCase(), last_name: 'X' })) };
    });
    const d = new MmDirectory(new MmClient(server.base, 't', { fetch: server.fetcher }));
    d.remember(toMmUser({ id: 'u-od', username: 'olivier.daumin', first_name: 'Olivier', last_name: 'Daumin' })!);
    await d.ensureUsernames(['emilie', 'maxime', 'olivier.daumi']);
    assert.equal(d.nameOf('emilie'), 'EMILIE X');
    assert.equal(d.nameOf('maxime'), 'MAXIME X');
    assert.equal(d.nameOfCut('olivier.daumi'), 'Olivier Daumin');
  });

  test('me, registered at sign-in with my username only, is looked up', async () => {
    const server = fakeServer((call) => (call.path === '/users/ids' ? { body: [{ id: 'u-me', username: 'me', first_name: 'Ada', last_name: 'L' }] } : undefined));
    const d = new MmDirectory(new MmClient(server.base, 't', { fetch: server.fetcher }));
    d.remember({ id: 'u-me', username: 'me', displayName: null, lastPictureUpdate: null });
    await d.ensure(['u-me']);
    assert.equal(d.user('u-me')?.displayName, 'Ada L');
  });
});
