import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { StoreWrites } from '../../lib/sync.ts';
import { parseFrame, type WaFrame, type WaMessage } from './frames.ts';
import { WhatsAppProjection } from './projection.ts';
import { filePath, photoVersion } from '../../lib/whatsappFiles.ts';

function fakeStore(known: string[] = []) {
  const rooms = new Map<string, LocalRoom>();
  const subscriptions = new Map<string, LocalSubscription>();
  const messages = new Map<string, LocalMessage>();
  const purges: { alive: string[]; known: string[] }[] = [];
  const people = new Map<string, { username: string; avatarEtag: string | null; name?: string | null }>();
  let transactions = 0;
  const tx = {
    upsertRoom: async (r: LocalRoom) => { rooms.set(r.rid, r); },
    upsertSubscription: async (s: LocalSubscription) => { subscriptions.set(s.rid, s); },
    upsertMessage: async (m: LocalMessage) => { messages.set(m.id, m); },
  } as unknown as StoreWrites;
  return {
    rooms, subscriptions, messages, purges, people, get transactions() { return transactions; },
    store: {
      transaction: async (fn: (w: StoreWrites) => Promise<void>) => { transactions++; await fn(tx); },
      listKnownRids: async () => known,
      purgeMissingRooms: async (alive: string[], knownRids: string[]) => { purges.push({ alive, known: knownRids }); },
      saveIdentity: async (i: { uid: string; username: string; avatarEtag: string | null; name?: string | null }) => { people.set(i.uid, i); },
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
  assert.equal(fake.messages.get('g@g.us:1')!.text, 'La vue');
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

test('attachments take the shape the timeline draws, their file asked for through the file path', async () => {
  const { p, fake } = projection();
  p.apply(message({ id: 'a@s.whatsapp.net:P', chat: 'a@s.whatsapp.net', kind: 'image', mime: 'image/jpeg', text: '', width: 800, height: 600, size: 1234 }));
  p.apply(message({ id: 'a@s.whatsapp.net:V', chat: 'a@s.whatsapp.net', kind: 'voice', mime: 'audio/ogg; codecs=opus', text: '', ts: 2 }));
  p.apply(message({ id: 'a@s.whatsapp.net:D', chat: 'a@s.whatsapp.net', kind: 'document', file_name: 'plan.pdf', text: 'le plan', ts: 3 }));
  await p.flush();
  const image = JSON.parse(fake.messages.get('a@s.whatsapp.net:P')!.attachments!)[0];
  assert.equal(image.image_url, filePath('a@s.whatsapp.net:P'));
  assert.equal(image.title_link, image.image_url);
  assert.deepEqual(image.image_dimensions, { width: 800, height: 600 });
  assert.equal(fake.messages.get('a@s.whatsapp.net:P')!.text, null);
  const voice = JSON.parse(fake.messages.get('a@s.whatsapp.net:V')!.attachments!)[0];
  assert.deepEqual([voice.audio_type, voice.title], ['audio/ogg', '[voice]']);
  const document = JSON.parse(fake.messages.get('a@s.whatsapp.net:D')!.attachments!)[0];
  assert.deepEqual([document.title, document.image_url, fake.messages.get('a@s.whatsapp.net:D')!.text], ['plan.pdf', undefined, 'le plan']);
});

test('photos version the chats and the people, mine under my username; a removal is none', async () => {
  const { p, fake } = projection();
  p.apply(message({}));
  p.apply(message({ id: 'g@g.us:1', chat: 'g@g.us', sender: 'bob@s.whatsapp.net' }));
  p.apply({ type: 'avatar', jid: 'alice@s.whatsapp.net', data: '/9j/alice' });
  p.apply({ type: 'avatar', jid: 'g@g.us', data: '/9j/group' });
  p.apply({ type: 'avatar', jid: me.userId, data: '/9j/me' });
  await p.flush();
  assert.equal(fake.rooms.get('alice@s.whatsapp.net')!.avatarEtag, photoVersion('/9j/alice'));
  assert.equal(fake.rooms.get('g@g.us')!.avatarEtag, photoVersion('/9j/group'));
  assert.equal(fake.people.get('alice@s.whatsapp.net')!.avatarEtag, photoVersion('/9j/alice'));
  // Named in the timeline by that row: her push name until the names table knows her.
  assert.equal(fake.people.get('alice@s.whatsapp.net')!.username, 'Alice (push)');
  p.apply({ type: 'names', names: { 'alice@s.whatsapp.net': 'Alice Martin' } });
  await p.flush();
  assert.equal(fake.people.get('alice@s.whatsapp.net')!.username, 'Alice Martin');
  assert.equal(fake.people.has('g@g.us'), false);
  assert.deepEqual([fake.people.get(me.userId)!.username, fake.people.get(me.userId)!.avatarEtag], [me.username, photoVersion('/9j/me')]);
  p.apply({ type: 'avatar', jid: 'alice@s.whatsapp.net', data: '' });
  await p.flush();
  assert.equal(fake.people.get('alice@s.whatsapp.net')!.avatarEtag, 'none');
});

test('a reply carries the quoted message as a quote block, from the cache when it has it', async () => {
  const { p, fake } = projection();
  p.apply({ type: 'names', names: { 'alice@s.whatsapp.net': 'Alice Martin' } });
  p.apply(message({ id: 'alice@s.whatsapp.net:Q', text: 'La question' }));
  p.apply(message({ id: 'alice@s.whatsapp.net:R', sender: 'me', mine: true, text: 'La réponse', ts: 2000,
    reply_to: 'alice@s.whatsapp.net:Q', quote_sender: 'alice@s.whatsapp.net', quote_text: 'old words' }));
  p.apply(message({ id: 'alice@s.whatsapp.net:S', text: 'Et ça ?', ts: 3000,
    reply_to: 'alice@s.whatsapp.net:GONE', quote_sender: 'me', quote_text: 'what I said' }));
  await p.flush();
  const quote = JSON.parse(fake.messages.get('alice@s.whatsapp.net:R')!.attachments!)[0];
  assert.deepEqual(quote, { message_link: 'wa-reply:alice@s.whatsapp.net:Q', author_name: 'Alice Martin', text: 'La question' });
  assert.equal(fake.messages.get('alice@s.whatsapp.net:R')!.text, 'La réponse');
  const uncached = JSON.parse(fake.messages.get('alice@s.whatsapp.net:S')!.attachments!)[0];
  assert.deepEqual([uncached.author_name, uncached.text], ['Me', 'what I said']);
});
