import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { NativeChat } from './chat.ts';
import type { NativeTransport } from './transport.ts';
import { NativeAdmin, nativeOverview, nativeReportedMessage, nativeReports, nativeRoom, nativeUser } from './admin.ts';

const alice = { id: 'u1', username: 'alice', display_name: 'Alice' };
const deleted = { id: 'u9', username: 'deleted-u9', display_name: '', deleted: true };

describe('native administration mapping', () => {
  test('overview: uptime from the start time, PostgreSQL named', () => {
    const o = nativeOverview({
      server_version: '0.3.0', postgres_version: '18.1', migration_version: '0050', instance_id: 'i1', data_epoch: 'e1',
      started_at: '2026-10-07T18:00:00Z',
      users: { total: 3, active: 2, deactivated: 1, admins: 1, online: 1, away: 0, busy: 0, offline: 2 },
      rooms: { total: 4, public: 2, private: 1, direct: 1, encrypted: 1 },
      messages: { total: 10, public: 6, private: 2, direct: 2, encrypted: 1 },
      uploads: { count: 1, bytes: 2048 }, reports: { messages: 1, users: 0 },
    }, Date.parse('2026-10-07T19:00:00Z'));
    assert.equal(o.uptimeSeconds, 3600);
    assert.equal(o.database, 'PostgreSQL 18.1');
    assert.equal(o.runtime, null);
    assert.equal(o.rooms.discussions, null);
    assert.equal(o.messages.encrypted, 1);
  });

  test('a user: disabled is inactive, avatar file as its version', () => {
    const u = nativeUser({ id: 'u1', username: 'alice', display_name: '', admin: true, disabled: true, status: 'offline', revision: '7', avatar_file_id: null });
    assert.deepEqual([u.name, u.active, u.admin, u.revision, u.avatar.etag], ['alice', false, true, '7', 'none']);
  });

  test('a direct room is named by its pair, a deleted member kept as such', () => {
    const r = nativeRoom({ id: 'd1', kind: 'direct', name: 'alice,bob', member_count: 2, message_count: 3, read_only: false, encrypted: true, direct_members: [alice, deleted] });
    assert.deepEqual([r.kind, r.name, r.encrypted], ['direct', 'Alice, deleted-u9', true]);
    assert.deepEqual(r.directMembers?.map((m) => m.deleted), [false, true]);
  });

  test('a reported message carries its reasons and a deleted author', () => {
    const m = nativeReportedMessage({
      message_id: 'm1', room_id: 'r1', room_kind: 'public', room_name: 'general', author: deleted, text: '', created_at: '2026-10-07T18:00:00Z',
      deleted: true, report_count: 2, latest_report_at: '2026-10-07T19:00:00Z',
      reports: [{ reporter: alice, reason: 'spam', created_at: '2026-10-07T19:00:00Z' }],
    });
    assert.equal(m.author.deleted, true);
    assert.deepEqual(m.reports?.map((r) => [r.reporter?.username, r.reason]), [['alice', 'spam']]);
  });
});

/** A chat whose `administration` runs the call on a recording transport. */
function fakeChat(transport: Partial<NativeTransport>, capabilities: Record<string, boolean> = { administration: true, reports: true }) {
  const asked: string[] = [];
  let n = 0;
  const chat = {
    capabilities,
    administration: async (capability: string, call: (t: NativeTransport, op: () => string) => Promise<unknown>) => {
      asked.push(capability);
      return call(transport as NativeTransport, () => `op-${++n}`);
    },
  } as unknown as NativeChat;
  return { chat, asked };
}

describe('NativeAdmin', () => {
  test('admin through /me/permissions, only where the server offers it', async () => {
    const permissions = { create_private_room: true, create_public_room: true, manage_accounts: false, manage_instance: true };
    assert.equal(await new NativeAdmin(fakeChat({ accountPermissions: async () => permissions }).chat).isAdmin(), true);
    assert.equal(await new NativeAdmin(fakeChat({ accountPermissions: async () => permissions }, { administration: false }).chat).isAdmin(), false);
  });

  test('the bot switch: absent without bots, read and set with an operation id', async () => {
    const inputs: unknown[] = [];
    const transport: Partial<NativeTransport> = {
      instanceSettings: async () => ({ user_bots: false }),
      updateInstanceSettings: async (input) => { inputs.push(input); return { user_bots: input.user_bots === true }; },
    };
    assert.equal(await new NativeAdmin(fakeChat(transport).chat).userBots(), null);
    const admin = new NativeAdmin(fakeChat(transport, { administration: true, bots: true }).chat);
    assert.equal(await admin.userBots(), false);
    assert.equal(await admin.setUserBots(true), true);
    assert.deepEqual(inputs, [{ operation_id: 'op-1', user_bots: true }]);
  });

  test('a change carries the revision and a fresh operation id', async () => {
    const inputs: unknown[] = [];
    const { chat } = fakeChat({
      updateAdminUser: async (_id, input) => { inputs.push(input); return { id: 'u1', username: 'alice', display_name: 'Alice', admin: false, disabled: true, status: 'offline', revision: '8' }; },
      deleteAdminUser: async (_id, input) => { inputs.push(input); },
    });
    const admin = new NativeAdmin(chat);
    const user = nativeUser({ id: 'u1', username: 'alice', display_name: 'Alice', admin: false, disabled: false, status: 'online', revision: '7' });
    assert.equal((await admin.updateUser(user, { active: false })).revision, '8');
    await admin.deleteUser(user);
    assert.deepEqual(inputs, [{ operation_id: 'op-1', revision: '7', disabled: true }, { operation_id: 'op-2', revision: '7' }]);
  });

  test('an author revision given by the item deactivates without a lookup', async () => {
    const inputs: unknown[] = [];
    const { chat } = fakeChat({
      adminUsers: async () => { throw new Error('no lookup expected'); },
      updateAdminUser: async (_id, input) => { inputs.push(input); return { id: 'u1', username: 'alice', display_name: 'Alice', admin: false, disabled: true, status: 'offline', revision: '6' }; },
    });
    await new NativeAdmin(chat).deactivate({ id: 'u1', username: 'alice', name: 'Alice', deleted: false, revision: '5' });
    assert.deepEqual(inputs, [{ operation_id: 'op-1', revision: '5', disabled: true }]);
  });

  test('deactivating a reported author reads its revision first', async () => {
    const inputs: unknown[] = [];
    const { chat } = fakeChat({
      adminUsers: async (page) => { inputs.push(page); return { items: [{ id: 'u1', username: 'alice', display_name: 'Alice', admin: false, disabled: false, status: 'online', revision: '3' }], next: null }; },
      updateAdminUser: async (_id, input) => { inputs.push(input); return { id: 'u1', username: 'alice', display_name: 'Alice', admin: false, disabled: true, status: 'offline', revision: '4' }; },
    });
    await new NativeAdmin(chat).deactivate({ id: 'u1', username: 'alice', name: 'Alice', deleted: false });
    assert.deepEqual(inputs, [{ limit: 100, q: 'alice' }, { operation_id: 'op-1', revision: '3', disabled: true }]);
  });

  test('lists are paged by the server cursor, searched with q', async () => {
    const pages: unknown[] = [];
    const { chat } = fakeChat({ adminRooms: async (page) => { pages.push(page); return { items: [], next: 'r9' }; } });
    assert.equal((await new NativeAdmin(chat).rooms('gen', 'r1')).next, 'r9');
    assert.deepEqual(pages, [{ limit: 50, after: 'r1', q: 'gen' }]);
  });

  test('reports go through the reports capability with an operation id', async () => {
    const sent: unknown[] = [];
    const { chat, asked } = fakeChat({
      reportMessage: async (id, input) => { sent.push([id, input]); },
      reportUser: async (id, input) => { sent.push([id, input]); },
    });
    await nativeReports(chat).message('m1', 'spam');
    await nativeReports(chat).user('u1', 'rude');
    assert.deepEqual(asked, ['reports', 'reports']);
    assert.deepEqual(sent, [['m1', { operation_id: 'op-1', reason: 'spam' }], ['u1', { operation_id: 'op-2', reason: 'rude' }]]);
  });
});
