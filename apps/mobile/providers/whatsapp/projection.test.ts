import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { StoreWrites } from '../../lib/sync.ts';
import { parseFrame, type WaFrame, type WaMessage } from './frames.ts';
import { WhatsAppProjection } from './projection.ts';

function fakeStore(known: string[] = []) {
  const rooms = new Map<string, LocalRoom>();
  const subscriptions = new Map<string, LocalSubscription>();
  const messages = new Map<string, LocalMessage>();
  const purges: { alive: string[]; known: string[] }[] = [];
  let transactions = 0;
  const tx = {
    upsertRoom: async (r: LocalRoom) => { rooms.set(r.rid, r); },
    upsertSubscription: async (s: LocalSubscription) => { subscriptions.set(s.rid, s); },
    upsertMessage: async (m: LocalMessage) => { messages.set(m.id, m); },
  } as unknown as StoreWrites;
  return {
    rooms, subscriptions, messages, purges, get transactions() { return transactions; },
    store: {
      transaction: async (fn: (w: StoreWrites) => Promise<void>) => { transactions++; await fn(tx); },
      listKnownRids: async () => known,
      purgeMissingRooms: async (alive: string[], knownRids: string[]) => { purges.push({ alive, known: knownRids }); },
    },
  };
}

const labels = { me: 'Me', deleted: 'This message was deleted', kind: (k: string) => `[${k}]` };
const me = { userId: '33600000000@s.whatsapp.net', username: '33600000000@s.whatsapp.net' };
const message = (over: Partial<WaMessage>): WaFrame => ({ type: 'message', message: {
  id: 'alice@s.whatsapp.net:1', chat: 'alice@s.whatsapp.net', name: 'alice', sender: 'alice@s.whatsapp.net',
  author: 'Alice (push)', text: 'Bonjour', ts: 1000, mine: false, ...over,
} });

function projection(known: string[] = []) {
  const fake = fakeStore(known);
  // Flushed by hand: no timer in the tests.
  const p = new WhatsAppProjection(fake.store, me, labels, () => {});
  return { p, fake };
}

test('a chat becomes a room with its newest message, its name and its unread count', async () => {
  const { p, fake } = projection();
  p.apply(message({}));
  p.apply(message({ id: 'alice@s.whatsapp.net:2', text: 'Ça va ?', ts: 2000 }));
  p.apply(message({ id: 'alice@s.whatsapp.net:0', text: 'older', ts: 500 }));
  p.apply({ type: 'chat', jid: 'alice@s.whatsapp.net', unread: 2 });
  p.apply({ type: 'names', names: { 'alice@s.whatsapp.net': 'Alice Martin' } });
  await p.flush();
  assert.equal(fake.transactions, 1);
  const room = fake.rooms.get('alice@s.whatsapp.net')!;
  assert.deepEqual([room.type, room.displayName, room.lastMessage, room.lastMessageTs, room.dmOtherUid],
    ['d', 'Alice Martin', 'Ça va ?', 2000, 'alice@s.whatsapp.net']);
  const sub = fake.subscriptions.get('alice@s.whatsapp.net')!;
  assert.deepEqual([sub.unread, sub.alert, sub.open], [2, true, true]);
  assert.equal(fake.messages.size, 3);
  assert.equal(fake.messages.get('alice@s.whatsapp.net:1')!.authorName, 'Alice Martin');
  p.apply({ type: 'chat', jid: 'alice@s.whatsapp.net', unread: 0 });
  await p.flush();
  assert.equal(fake.subscriptions.get('alice@s.whatsapp.net')!.unread, 0);
});

test('my messages carry my id, groups are private rooms, attachments and deletions read in words', async () => {
  const { p, fake } = projection();
  p.apply(message({ id: 'g@g.us:1', chat: 'g@g.us', sender: 'bob@s.whatsapp.net', author: 'Bob', kind: 'image', text: 'La vue' }));
  p.apply(message({ id: 'g@g.us:2', chat: 'g@g.us', sender: 'me', mine: true, text: 'Super', ts: 3000 }));
  p.apply(message({ id: 'g@g.us:3', chat: 'g@g.us', sender: 'bob@s.whatsapp.net', deleted: true, text: '', ts: 2000 }));
  await p.flush();
  assert.equal(fake.rooms.get('g@g.us')!.type, 'p');
  assert.equal(fake.rooms.get('g@g.us')!.dmOtherUid, null);
  assert.equal(fake.rooms.get('g@g.us')!.displayName, 'g');
  assert.equal(fake.messages.get('g@g.us:1')!.text, '[image]\nLa vue');
  assert.deepEqual([fake.messages.get('g@g.us:2')!.authorId, fake.messages.get('g@g.us:2')!.authorName], [me.userId, 'Me']);
  assert.equal(fake.messages.get('g@g.us:3')!.text, 'This message was deleted');
});

test('reactions become shortcode chips, mine under my username, a removal empties them', async () => {
  const { p, fake } = projection();
  p.apply(message({}));
  p.apply({ type: 'reaction', reaction: { message: 'alice@s.whatsapp.net:1', sender: 'me', emoji: '👍', ts: 1 } });
  p.apply({ type: 'reaction', reaction: { message: 'alice@s.whatsapp.net:1', sender: 'alice@s.whatsapp.net', emoji: '❤️', ts: 2 } });
  await p.flush();
  const chips = JSON.parse(fake.messages.get('alice@s.whatsapp.net:1')!.reactions!) as Record<string, { usernames: string[] }>;
  assert.deepEqual(chips[':+1:']!.usernames, [me.username]);
  assert.deepEqual(chips[':heart:']!.usernames, ['alice@s.whatsapp.net']);
  p.apply({ type: 'reaction', reaction: { message: 'alice@s.whatsapp.net:1', sender: 'me', emoji: '', ts: 3 } });
  p.apply({ type: 'reaction', reaction: { message: 'alice@s.whatsapp.net:1', sender: 'alice@s.whatsapp.net', emoji: '', ts: 4 } });
  await p.flush();
  assert.equal(fake.messages.get('alice@s.whatsapp.net:1')!.reactions, null);
});

test('a link preview from the sender becomes a urls entry, an edit is dated', async () => {
  const { p, fake } = projection();
  p.apply(message({ text: 'see https://example.org', link_url: 'https://example.org', link_title: 'Example', edited: true }));
  await p.flush();
  const row = fake.messages.get('alice@s.whatsapp.net:1')!;
  assert.deepEqual(JSON.parse(row.urls!), [{ url: 'https://example.org', meta: { ogTitle: 'Example' } }]);
  assert.equal(row.editedAt, 1000);
});

test('a replay drops the chats it did not bring back, and an empty one drops nothing', async () => {
  const { p, fake } = projection(['alice@s.whatsapp.net', 'gone@s.whatsapp.net']);
  p.apply({ type: 'reload' });
  p.apply(message({}));
  p.apply({ type: 'replayed' });
  await p.flush();
  assert.deepEqual(fake.purges, [{ alive: ['alice@s.whatsapp.net'], known: ['alice@s.whatsapp.net', 'gone@s.whatsapp.net'] }]);
  p.apply({ type: 'reload' });
  p.apply({ type: 'replayed' });
  await p.flush();
  assert.equal(fake.purges.length, 1);
});

test('status, QR, pairing code, account and errors reach the watchers; only fatal errors end the account', () => {
  const { p } = projection();
  let calls = 0;
  p.subscribe(() => { calls++; });
  p.apply({ type: 'qr', code: 'QR', expires_ms: 60000 });
  p.apply({ type: 'pairing_code', code: 'ABCD1234' });
  assert.deepEqual([p.status.qr, p.status.pairingCode], ['QR', 'ABCD1234']);
  p.apply({ type: 'error', code: 'phone_invalid' });
  assert.notEqual(p.status.state, 'error');
  p.apply({ type: 'error', code: 'invalid_send', id: 'ABC' });
  assert.equal(p.status.refused, 'ABC');
  p.apply({ type: 'account', jid: me.userId, name: 'Moi' });
  p.apply({ type: 'status', state: 'connected' });
  assert.deepEqual([p.status.state, p.status.qr, p.status.account?.name], ['connected', null, 'Moi']);
  p.apply({ type: 'error', code: 'session_ended' });
  assert.equal(p.status.state, 'error');
  assert.equal(calls, 7);
  assert.equal(parseFrame('{"type":"a_newer_frame"}')?.type, 'a_newer_frame');
  assert.equal(parseFrame('not json'), null);
});
