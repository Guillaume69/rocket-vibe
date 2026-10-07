import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RestClient } from '../../lib/rest.ts';
import { AdminRC, rcOverview, rcReports, rcRoom, rcUser } from './admin.ts';

/** Fake client: answers by path, records every call. */
function fakeClient(answers: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; options: unknown }[] = [];
  const answer = (path: string) => (path in answers ? answers[path] : {});
  const client = {
    get: async (path: string, options: unknown) => {
      calls.push({ method: 'GET', path, options });
      return answer(path);
    },
    post: async (path: string, options: unknown) => {
      calls.push({ method: 'POST', path, options });
      return answer(path);
    },
  } as unknown as RestClient;
  return { client, calls };
}

// Shapes as the 8.5.1 bench answered them (2026-10-07).
const STATS = {
  version: '8.5.1', uniqueId: 'fe23', mongoVersion: '8.0.32', mongoStorageEngine: 'wiredTiger',
  migration: { version: 335 }, process: { nodeVersion: 'v22.22.3', uptime: 3107.7 },
  totalUsers: 4, activeUsers: 3, nonActiveUsers: 0, onlineUsers: 1, awayUsers: 0, busyUsers: 0, offlineUsers: 3,
  totalRooms: 4, totalChannels: 2, totalPrivateGroups: 1, totalDirect: 1, totalDiscussions: 0,
  totalMessages: 54, totalChannelMessages: 30, totalPrivateGroupMessages: 12, totalDirectMessages: 12, totalDiscussionsMessages: 0,
  uploadsTotal: 2, uploadsTotalSize: 200,
};

describe('Rocket.Chat administration mapping', () => {
  test('statistics give the overview', () => {
    const o = rcOverview(STATS, 1, { messages: 2, users: 1 });
    assert.equal(o.version, '8.5.1');
    assert.equal(o.database, 'MongoDB 8.0.32 (wiredTiger)');
    assert.equal(o.runtime, 'Node v22.22.3');
    assert.equal(o.migration, '335');
    assert.equal(o.uptimeSeconds, 3107.7);
    assert.deepEqual(o.users, { total: 4, active: 3, deactivated: 0, admins: 1, online: 1, away: 0, busy: 0, offline: 3 });
    assert.deepEqual(o.rooms, { total: 4, public: 2, private: 1, direct: 1, discussions: 0, encrypted: null });
    assert.deepEqual(o.uploads, { count: 2, bytes: 200 });
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

  test('a direct room is named by its members, a discussion by its parent', () => {
    assert.equal(rcRoom({ _id: 'd1', t: 'd', usernames: ['admin', 'alice'], usersCount: 2, msgs: 12 }).name, 'admin, alice');
    assert.equal(rcRoom({ _id: 'x', t: 'p', prid: 'p1', fname: 'Plans', name: 'plans' }).kind, 'discussion');
    const r = rcRoom({ _id: 'p1', t: 'p', fname: 'test-prive', name: 'test-prive', usersCount: 2, msgs: 12, ro: true, encrypted: true, ts: '2026-10-06T20:27:05.446Z' });
    assert.deepEqual([r.kind, r.name, r.members, r.messages, r.readOnly, r.encrypted], ['private', 'test-prive', 2, 12, true, true]);
  });
});

describe('AdminRC', () => {
  test('is admin through me.roles', async () => {
    assert.equal(await new AdminRC(fakeClient({ me: { roles: ['user', 'admin'] } }).client).isAdmin(), true);
    assert.equal(await new AdminRC(fakeClient({ me: { roles: ['user'] } }).client).isAdmin(), false);
  });

  test('the overview asks fresh statistics and sums the open message reports', async () => {
    const { client, calls } = fakeClient({
      statistics: STATS,
      'roles.getUsersInRole': { total: 1 },
      'moderation.reportsByUsers': { reports: [{ count: 2 }, { count: 1 }] },
      'moderation.userReports': { total: 1 },
    });
    const o = await new AdminRC(client).overview();
    assert.deepEqual(o.reports, { messages: 3, users: 1 });
    assert.equal(o.users.admins, 1);
    assert.deepEqual(calls[0], { method: 'GET', path: 'statistics', options: { params: { refresh: true } } });
  });

  test('users are searched server-side and paged by offset', async () => {
    const { client, calls } = fakeClient({ 'users.listByStatus': { users: [{ _id: 'u1', username: 'alice' }], total: 51 } });
    const page = await new AdminRC(client).users(' ali ', '50');
    assert.equal(page.next, null);
    assert.deepEqual(calls[0]!.options, { params: { count: 50, offset: 50, sort: '{"username":1}', searchTerm: 'ali' } });
  });

  test('admin right and activation, one change at a time', async () => {
    const { client, calls } = fakeClient({ 'users.setActiveStatus': { user: { _id: 'u1', active: false } } });
    const admin = new AdminRC(client);
    const user = rcUser({ _id: 'u1', username: 'alice' });
    assert.equal((await admin.updateUser(user, { admin: true })).admin, true);
    assert.equal((await admin.updateUser(user, { active: false })).active, false);
    await admin.deleteUser(user);
    assert.deepEqual(calls.map((c) => [c.path, c.options]), [
      ['roles.addUserToRole', { body: { roleId: 'admin', username: 'alice' } }],
      ['users.setActiveStatus', { body: { userId: 'u1', activeStatus: false, confirmRelinquish: true } }],
      ['users.delete', { body: { userId: 'u1', confirmRelinquish: true } }],
    ]);
  });

  test('reported messages: authors fanned out, one entry per message', async () => {
    const report = (id: string, ts: string) => ({
      _id: `rep-${ts}`, ts,
      message: { _id: id, msg: `text ${id}`, ts: '2026-10-06T20:27:06.955Z', rid: 'p1', u: { _id: 'a1', username: 'admin', name: 'Admin' } },
      room: { _id: 'p1', name: 'test-prive', fname: 'test-prive', t: 'p' },
    });
    const { client, calls } = fakeClient({
      'moderation.reportsByUsers': { reports: [{ userId: 'a1', username: 'admin', count: 3, isUserDeleted: false }], total: 1 },
      'moderation.user.reportedMessages': {
        user: { _id: 'a1', username: 'admin', name: 'Admin' },
        messages: [report('m1', '2026-10-07T18:00:00Z'), report('m2', '2026-10-07T19:00:00Z'), report('m1', '2026-10-07T20:00:00Z')],
      },
    });
    const page = await new AdminRC(client).reportedMessages(null);
    assert.deepEqual(page.items.map((m) => [m.messageId, m.count, m.room.kind, m.author.username]), [
      ['m1', 2, 'private', 'admin'],
      ['m2', 1, 'private', 'admin'],
    ]);
    assert.equal(page.next, null);
    assert.deepEqual(calls[1]!.options, { params: { userId: 'a1', count: 100 } });
  });

  test('reasons, dismissal and moderation delete', async () => {
    const { client, calls } = fakeClient({
      'moderation.reports': { reports: [{ description: 'spam', reportedBy: { _id: 'u2', username: 'alice', name: 'Alice Martin' }, ts: '2026-10-07T18:51:51.051Z' }] },
    });
    const admin = new AdminRC(client);
    const item = {
      messageId: 'm1', room: { id: 'p1', name: 'test-prive', kind: 'private' as const },
      author: { id: 'a1', username: 'admin', name: 'Admin', deleted: false }, text: 't', createdAt: null,
      deleted: false, count: 1, latestAt: null, reports: null,
    };
    const reasons = await admin.messageReports(item);
    assert.deepEqual(reasons.map((r) => [r.reporter?.username, r.reason]), [['alice', 'spam']]);
    await admin.deleteReportedMessage(item);
    await admin.deactivate(item.author);
    assert.deepEqual(calls.slice(1).map((c) => [c.path, c.options]), [
      ['chat.delete', { body: { roomId: 'p1', msgId: 'm1' } }],
      ['moderation.dismissReports', { body: { msgId: 'm1' } }],
      ['users.setActiveStatus', { body: { userId: 'a1', activeStatus: false, confirmRelinquish: true } }],
    ]);
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
