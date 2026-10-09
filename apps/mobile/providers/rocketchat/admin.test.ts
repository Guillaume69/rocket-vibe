import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BulkDeleteRequired, LastOwnerError, type ReportedMessage } from '../../lib/admin.ts';
import { RestError, type RestClient } from '../../lib/rest.ts';
import { AdminRC, rcEmojis, rcOverview, rcReportedMessages, rcReports, rcRoom, rcUser } from './admin.ts';

type Answer = unknown | ((options: unknown) => unknown);

/** Fake client: answers by path (a function may throw), records every call. */
function fakeClient(answers: Record<string, Answer> = {}) {
  const calls: { method: string; path: string; options: unknown }[] = [];
  const answer = async (path: string, options: unknown) => {
    const a = path in answers ? answers[path] : {};
    return typeof a === 'function' ? (a as (o: unknown) => unknown)(options) : a;
  };
  const client = {
    get: async (path: string, options: unknown) => {
      calls.push({ method: 'GET', path, options });
      return answer(path, options);
    },
    post: async (path: string, options: unknown) => {
      calls.push({ method: 'POST', path, options });
      return answer(path, options);
    },
  } as unknown as RestClient;
  return { client, calls };
}

const refused = (errorType: string, details?: unknown) => () => {
  throw new RestError(errorType, 400, errorType, errorType, true, details);
};

// Shapes as the 8.5.1 bench answered them (2026-10-07).
const STATS = {
  createdAt: '2026-10-07T21:50:36.672Z',
  version: '8.5.1', uniqueId: 'fe23', mongoVersion: '8.0.32', mongoStorageEngine: 'wiredTiger',
  migration: { version: 335 }, process: { nodeVersion: 'v22.22.3', uptime: 3107.7 },
  totalUsers: 4, activeUsers: 3, nonActiveUsers: 0, onlineUsers: 1, awayUsers: 0, busyUsers: 0, offlineUsers: 3,
  totalRooms: 4, totalChannels: 2, totalPrivateGroups: 1, totalDirect: 1, totalDiscussions: 0,
  totalMessages: 54, totalChannelMessages: 30, totalPrivateGroupMessages: 12, totalDirectMessages: 12, totalDiscussionsMessages: 0,
  uploadsTotal: 2, uploadsTotalSize: 200,
};

describe('Rocket.Chat administration mapping', () => {
  test('statistics give the overview, dated by the snapshot', () => {
    const o = rcOverview(STATS, 1, { messages: 2, users: null });
    assert.equal(o.asOf, Date.parse('2026-10-07T21:50:36.672Z'));
    assert.equal(o.version, '8.5.1');
    assert.equal(o.database, 'MongoDB 8.0.32 (wiredTiger)');
    assert.equal(o.runtime, 'Node v22.22.3');
    assert.equal(o.migration, '335');
    assert.equal(o.uptimeSeconds, 3107.7);
    assert.deepEqual(o.users, { total: 4, active: 3, deactivated: 0, admins: 1, online: 1, away: 0, busy: 0, offline: 3 });
    assert.deepEqual(o.rooms, { total: 4, public: 2, private: 1, direct: 1, discussions: 0, encrypted: null });
    assert.deepEqual(o.uploads, { count: 2, bytes: 200 });
    assert.deepEqual(o.reports, { messages: 2, users: null });
  });

  test('a user: admin role, bot type, avatar version, last login', () => {
    const u = rcUser({ _id: 'u1', username: 'alice', name: 'Alice Martin', roles: ['user', 'admin'], type: 'bot', active: false, status: 'away', lastLogin: '2026-10-07T18:43:11.309Z', avatarETag: 'Fp' });
    assert.equal(u.admin, true);
    assert.equal(u.bot, true);
    assert.equal(u.active, false);
    assert.equal(u.status, 'away');
    assert.deepEqual(u.avatar, { username: 'alice', etag: 'Fp' });
    assert.equal(u.createdAt, null);
    assert.equal(u.revision, null);
  });

  test('no avatarETag means no photo: the marker, not the bare URL', () => {
    assert.deepEqual(rcUser({ _id: 'u2', username: 'bob' }).avatar, { username: 'bob', etag: 'none' });
  });

  test('a direct room is named by its members, a discussion by its parent', () => {
    assert.equal(rcRoom({ _id: 'd1', t: 'd', usernames: ['admin', 'alice'], usersCount: 2, msgs: 12 }).name, 'admin, alice');
    assert.equal(rcRoom({ _id: 'x', t: 'p', prid: 'p1', fname: 'Plans', name: 'plans' }).kind, 'discussion');
    const r = rcRoom({ _id: 'p1', t: 'p', fname: 'test-prive', name: 'test-prive', usersCount: 2, msgs: 12, ro: true, ts: '2026-10-06T20:27:05.446Z' });
    assert.deepEqual([r.kind, r.name, r.members, r.messages, r.readOnly, r.encrypted], ['private', 'test-prive', 2, 12, true, false]);
  });

  test('an encrypted reported message keeps no text', () => {
    const [m] = rcReportedMessages({
      user: { _id: 'a1', username: 'alice' },
      messages: [{ ts: '2026-10-07T18:00:00Z', message: { _id: 'm1', t: 'e2e', msg: 'ciphertext', rid: 'p1' }, room: { _id: 'p1', t: 'p', name: 'secret' } }],
    }, false);
    assert.equal(m!.encrypted, true);
    assert.equal(m!.text, '');
  });
});

// One entry per MESSAGE, as `moderation.user.reportedMessages` answers.
const entry = (id: string, ts: string, room = { _id: 'p1', name: 'test-prive', fname: 'test-prive', t: 'p' }) => ({
  _id: `rep-${id}`, ts,
  message: { _id: id, msg: `text ${id}`, ts: '2026-10-06T20:27:06.955Z', rid: room._id, u: { _id: 'a1', username: 'admin', name: 'Admin' } },
  room,
});

const item = (over: Partial<ReportedMessage> = {}): ReportedMessage => ({
  messageId: 'm1', room: { id: 'p1', name: 'test-prive', kind: 'private' }, encrypted: false,
  author: { id: 'a1', username: 'admin', name: 'Admin', deleted: false }, text: 't', createdAt: null,
  deleted: false, count: 1, latestAt: null, reports: null, ...over,
});

describe('AdminRC', () => {
  test('is admin through me.roles', async () => {
    assert.equal(await new AdminRC(fakeClient({ me: { roles: ['user', 'admin'] } }).client).isAdmin(), true);
    assert.equal(await new AdminRC(fakeClient({ me: { roles: ['user'] } }).client).isAdmin(), false);
  });

  test('the overview opens on the cached statistics; refresh asks fresh ones', async () => {
    const { client, calls } = fakeClient({
      statistics: STATS,
      'roles.getUsersInRole': { total: 1 },
      'moderation.reportsByUsers': { reports: [{ count: 2 }, { count: 1 }] },
      'moderation.userReports': { total: 1 },
    });
    const admin = new AdminRC(client);
    const o = await admin.overview();
    assert.deepEqual(o.reports, { messages: 3, users: 1 });
    assert.equal(o.users.admins, 1);
    await admin.overview(true);
    const reads = calls.filter((c) => c.path === 'statistics').map((c) => c.options);
    assert.deepEqual(reads, [{}, { params: { refresh: true } }]);
  });

  test('a missing right leaves its figure unknown, never the dashboard', async () => {
    const { client } = fakeClient({
      statistics: STATS,
      'roles.getUsersInRole': refused('error-not-authorized'),
      'moderation.reportsByUsers': refused('error-not-authorized'),
      'moderation.userReports': refused('error-not-authorized'),
    });
    const o = await new AdminRC(client).overview();
    assert.equal(o.users.admins, null);
    assert.deepEqual(o.reports, { messages: null, users: null });
  });

  test('users are searched server-side and paged by offset', async () => {
    const { client, calls } = fakeClient({ 'users.listByStatus': { users: [{ _id: 'u1', username: 'alice' }], total: 51 } });
    const page = await new AdminRC(client).users(' ali ', '50');
    assert.equal(page.next, null);
    assert.deepEqual(calls[0]!.options, { params: { count: 50, offset: 50, sort: '{"username":1}', searchTerm: 'ali' } });
  });

  test('rooms of every type, discussions and teams included', async () => {
    const { client, calls } = fakeClient({ 'rooms.adminRooms?types[]=c&types[]=p&types[]=d&types[]=discussions&types[]=teams': { rooms: [], total: 0 } });
    await new AdminRC(client).rooms('gen', null);
    assert.deepEqual(calls[0], {
      method: 'GET',
      path: 'rooms.adminRooms?types[]=c&types[]=p&types[]=d&types[]=discussions&types[]=teams',
      options: { params: { count: 50, offset: 0, filter: 'gen' } },
    });
  });

  test('admin right and activation, one change at a time, no relinquish unasked', async () => {
    const { client, calls } = fakeClient({ 'users.setActiveStatus': { user: { _id: 'u1', active: false } } });
    const admin = new AdminRC(client);
    const user = rcUser({ _id: 'u1', username: 'alice' });
    assert.equal((await admin.updateUser(user, { admin: true })).admin, true);
    assert.equal((await admin.updateUser(user, { active: false })).active, false);
    await admin.deleteUser(user);
    assert.deepEqual(calls.map((c) => [c.path, c.options]), [
      ['roles.addUserToRole', { body: { roleId: 'admin', username: 'alice' } }],
      ['users.setActiveStatus', { body: { userId: 'u1', activeStatus: false } }],
      ['users.delete', { body: { userId: 'u1' } }],
    ]);
  });

  test('the last owner of rooms: the rooms named, then confirmed with relinquish', async () => {
    const details = { shouldBeRemoved: ['solo'], shouldChangeOwner: ['team'] };
    const { client, calls } = fakeClient({
      'users.delete': (o: unknown) => {
        const body = (o as { body: { confirmRelinquish?: boolean } }).body;
        if (body.confirmRelinquish !== true) refused('user-last-owner', details)();
        return {};
      },
    });
    const admin = new AdminRC(client);
    const user = rcUser({ _id: 'u1', username: 'tmp' });
    const error = await admin.deleteUser(user).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof LastOwnerError);
    assert.deepEqual([error.removed, error.reassigned], [['solo'], ['team']]);
    await admin.deleteUser(user, true);
    assert.deepEqual(calls.map((c) => c.options), [{ body: { userId: 'u1' } }, { body: { userId: 'u1', confirmRelinquish: true } }]);
  });

  test('reported messages: authors fanned out, each message counted on its own', async () => {
    const { client, calls } = fakeClient({
      'moderation.reportsByUsers': { reports: [{ userId: 'a1', username: 'admin', count: 3, isUserDeleted: false }], total: 1 },
      'moderation.user.reportedMessages': {
        user: { _id: 'a1', username: 'admin', name: 'Admin' },
        // `count` is the author's (3), not each message's.
        messages: [entry('m2', '2026-10-07T19:00:00Z'), entry('m1', '2026-10-07T20:00:00Z')],
        count: 2, total: 2,
      },
      'moderation.reports': (o: unknown) => ({ total: (o as { params: { msgId: string } }).params.msgId === 'm1' ? 2 : 1 }),
    });
    const page = await new AdminRC(client).reportedMessages(null);
    assert.deepEqual(page.items.map((m) => [m.messageId, m.count, m.room.kind, m.author.username]), [
      ['m1', 2, 'private', 'admin'],
      ['m2', 1, 'private', 'admin'],
    ]);
    assert.equal(page.next, null);
    assert.deepEqual(calls[1]!.options, { params: { userId: 'a1', count: 100 } });
    assert.deepEqual(calls.filter((c) => c.path === 'moderation.reports').map((c) => c.options), [
      { params: { msgId: 'm2', count: 1 } },
      { params: { msgId: 'm1', count: 1 } },
    ]);
  });

  test('reasons, dismissal, moderation delete and deactivation', async () => {
    const { client, calls } = fakeClient({
      'moderation.reports': { reports: [{ description: 'spam', reportedBy: { _id: 'u2', username: 'alice', name: 'Alice Martin' }, ts: '2026-10-07T18:51:51.051Z' }] },
    });
    const admin = new AdminRC(client);
    const reasons = await admin.messageReports(item());
    assert.deepEqual(reasons.map((r) => [r.reporter?.username, r.reason]), [['alice', 'spam']]);
    await admin.deleteReportedMessage(item());
    await admin.deactivate(item().author);
    assert.deepEqual(calls.slice(1).map((c) => [c.path, c.options]), [
      ['chat.delete', { body: { roomId: 'p1', msgId: 'm1' } }],
      ['moderation.dismissReports', { body: { msgId: 'm1' } }],
      ['users.setActiveStatus', { body: { userId: 'a1', activeStatus: false } }],
    ]);
  });

  test('a room out of reach: only the author-wide delete, asked for with its count', async () => {
    const { client, calls } = fakeClient({
      'chat.delete': refused('error-action-not-allowed'),
      'moderation.user.reportedMessages': { messages: [], total: 3 },
    });
    const admin = new AdminRC(client);
    const error = await admin.deleteReportedMessage(item()).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof BulkDeleteRequired);
    assert.equal(error.count, 3);
    assert.ok(!calls.some((c) => c.path === 'moderation.dismissReports' || c.path === 'moderation.user.deleteReportedMessages'));
    await admin.deleteAuthorReportedMessages(item());
    assert.deepEqual(calls.at(-1), { method: 'POST', path: 'moderation.user.deleteReportedMessages', options: { body: { userId: 'a1' } } });
  });

  test('members report a message or an account', async () => {
    const { client, calls } = fakeClient();
    await rcReports(client).message('m1', 'spam');
    await rcReports(client).user('u1', 'rude');
    assert.deepEqual(calls.map((c) => [c.path, c.options]), [
      ['chat.reportMessage', { body: { messageId: 'm1', description: 'spam' } }],
      ['moderation.reportUser', { body: { userId: 'u1', description: 'rude' } }],
    ]);
  });
});

describe('custom emoji', () => {
  test('the list keeps id, name and aliases, sorted, and skips broken entries', () => {
    const list = rcEmojis([
      { _id: 'e2', name: 'shipit', aliases: [], extension: 'png' },
      { _id: 'e1', name: 'party_parrot', aliases: ['rv_parrot', 3], extension: 'gif' },
      { name: 'no_id' },
    ]);
    assert.deepEqual(list, [
      { id: 'e1', name: 'party_parrot', aliases: ['rv_parrot'], revision: '' },
      { id: 'e2', name: 'shipit', aliases: [], revision: '' },
    ]);
    assert.deepEqual(rcEmojis(undefined), []);
  });
});
