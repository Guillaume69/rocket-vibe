import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from '../../lib/auth.ts';
import type { LocalMessage } from '../../lib/normalize.ts';
import type { OutboxRow, OutboxStore } from '../../lib/outbox.ts';
import type { SyncEngine } from '../../lib/sync.ts';
import { TeamsTokens, type TeamsRoutes } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox, clientMessageId } from './outbox.ts';
import { TeamsRooms, TeamsSync } from './sync.ts';
import { TeamsDirectory } from './translate.ts';
import { chatEvent, parseFrame } from './trouter.ts';
import { TEAMS_CAPABILITIES, typingAction } from './index.ts';

type Doc = Record<string, unknown>;
type Call = { method: string; url: string; body: Doc | null; headers: Record<string, string> };

const ME = '8:orgid:me';
const RID = '19:c@thread.v2';
const CHAT = 'https://emea.ng.msg.teams.microsoft.com';
const ROUTES: TeamsRoutes = {
  chat: CHAT, aggregator: 'https://teams.microsoft.com/api/csa/emea', trouter: 'https://go.trouter.teams.microsoft.com',
  registrar: 'https://teams.microsoft.com/registrar/prod', ams: 'https://eu-api.asm.skype.com', middleTier: 'https://teams.microsoft.com/api/mt/emea',
};
const SESSION: Session = {
  baseUrl: 'https://teams.microsoft.com', authToken: 'fixture', userId: ME, username: 'Me', kind: 'teams', siteUrl: null,
  teamsTenantId: 'tenant', teamsRefresh: 'fixture-refresh',
} as Session;

/** A fetch answering from `route`, recording each call. */
function fake(route: (call: Call) => { status?: number; body?: unknown } | 'throw') {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET', url: String(input),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Doc) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const answer = route(call);
    if (answer === 'throw') throw new TypeError('network down');
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  const client = new TeamsClient(TeamsTokens.preset(SESSION, ROUTES, 'skype-fixture', 'bearer-fixture', { fetch: fetcher }), { fetch: fetcher });
  return { calls, client };
}

const message = (id: string, extra: Doc = {}): Doc => ({
  id, messagetype: 'RichText/Html', contenttype: 'text', content: '<p>hi</p>', imdisplayname: 'Ada',
  from: `${CHAT}/v1/users/ME/contacts/8:orgid:ada`, originalarrivaltime: new Date(Number(id)).toISOString(), ...extra,
});

function engine() {
  const ingested: Doc[] = [];
  const deleted: string[] = [];
  const value = {
    ingestMessages: async (docs: Doc[]) => { ingested.push(...docs); },
    syncStore: { deleteMessage: async (id: string) => { deleted.push(id); } },
  } as unknown as SyncEngine;
  return { value, ingested, deleted };
}

test('history pages back through the backward link, on the chat host only', async () => {
  const older = `${CHAT}/v1/users/ME/conversations/${encodeURIComponent(RID)}/messages?syncState=older`;
  const { calls, client } = fake((call) => call.url === older
    ? { body: { messages: [message('2800'), message('2700')] } }
    : { body: { messages: [message('3000'), message('2900')], _metadata: { backwardLink: older } } });
  const sync = new TeamsSync(client, new TeamsRooms());
  const store = engine();

  assert.deepEqual(await sync.loadHistory(store.value, RID), { oldest: 2900 });
  assert.deepEqual(await sync.loadHistory(store.value, RID, new Date(2900).toISOString()), { oldest: 2700 });
  assert.deepEqual(store.ingested.map((m) => m.id), ['3000', '2900', '2800', '2700']);
  assert.ok(store.ingested.every((m) => m.__rid === RID));
  assert.equal(calls[1].url, older);
  assert.equal(calls[0].headers.authentication, 'skypetoken=skype-fixture');
});

test('a backward link to another host is never followed', async () => {
  const { calls, client } = fake(() => ({ body: { messages: [message('3000')], _metadata: { backwardLink: 'https://evil.example/steal' } } }));
  const sync = new TeamsSync(client, new TeamsRooms());
  const store = engine();
  await sync.loadHistory(store.value, RID);
  await sync.loadHistory(store.value, RID, new Date(3000).toISOString());
  assert.ok(calls.length > 0 && calls.every((c) => c.url.startsWith(CHAT)), calls.map((c) => c.url).join('\n'));
});

function outboxStore() {
  const rows: OutboxRow[] = [];
  const failed = new Map<string, string>();
  const store: OutboxStore = {
    enqueueMessage: async (m: LocalMessage & { text: string }) => {
      rows.push({ id: m.id, rid: m.rid, text: m.text, threadId: m.threadId, status: 'pending', attempts: 0, createdAt: m.ts });
    },
    listToSend: async () => rows.filter((r) => r.status === 'pending'),
    markFailed: async (id, error) => { failed.set(id, error); const r = rows.find((x) => x.id === id); if (r) r.status = 'failed'; },
    rearm: async (id) => { const r = rows.find((x) => x.id === id); if (r) r.status = 'pending'; },
    deleteOutbox: async (id) => { rows.splice(rows.findIndex((r) => r.id === id), 1); },
    upsertMessage: async () => {},
    deleteOptimisticMessage: async () => {},
    roomEncrypted: async () => false,
  };
  return { store, rows, failed };
}

test('a sent message is delivered once Teams echoes its client id from me', async () => {
  const rowId = '0123456789abcdef01234567';
  const marker = clientMessageId(rowId);
  const { calls, client } = fake((call) => call.method === 'POST'
    ? { status: 201, body: {} }
    : { body: { messages: [message('5000', { clientmessageid: marker, from: `${CHAT}/v1/users/ME/contacts/${ME}` })] } });
  const { store, rows, failed } = outboxStore();
  const ingested: Doc[] = [];
  const outbox = new TeamsOutbox({ store, client, directory: new TeamsDirectory(), me: { id: ME, username: 'Me' }, generateId: () => rowId, ingest: async (d) => { ingested.push(d); } });

  await outbox.send(RID, 'a < b');
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.body?.clientmessageid, marker);
  assert.equal(post.body?.content, '<p>a &lt; b</p>');
  assert.equal(rows.length, 0);
  assert.equal(failed.size, 0);
  assert.deepEqual(ingested.map((d) => [d.id, d.__rid]), [['5000', RID]]);
});

test('a lost answer with no echo is marked uncertain, never sent twice', async () => {
  const { calls, client } = fake((call) => call.method === 'POST' ? 'throw' : { body: { messages: [message('5000', { clientmessageid: 'someone-else' })] } });
  const { store, failed } = outboxStore();
  const outbox = new TeamsOutbox({ store, client, directory: new TeamsDirectory(), me: { id: ME, username: 'Me' }, generateId: () => 'aa', ingest: async () => {} });

  await outbox.send(RID, 'hello');
  await outbox.process();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.match(failed.get('aa') ?? '', /could not be confirmed/);
});

test('the read horizon only moves forward', async () => {
  const { calls, client } = fake(() => ({ body: {} }));
  const actions = new TeamsMessageActions(client, async () => {});
  await actions.markRead(RID, `${RID}/500`);
  await actions.markRead(RID, `${RID}/400`);
  await actions.markRead(RID, null);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.match(String(puts[0].body?.consumptionhorizon), /^500;\d+;500$/);
  assert.ok(puts[0].url.includes('name=consumptionhorizon'));
});

test('a reaction outside the classic set is refused before any call', async () => {
  const { calls, client } = fake(() => ({ body: {} }));
  const actions = new TeamsMessageActions(client, async () => {});
  await assert.rejects(actions.react(RID, `${RID}/500`, ':rocket_not_a_teams_key:', true));
  assert.equal(calls.length, 0);
});

test('a Trouter message frame carries a chat event', () => {
  const resource = { id: '6000', conversationLink: `${CHAT}/v1/users/ME/conversations/${RID}` };
  const envelope = { id: 7, url: '/v4/f/x/messaging', body: JSON.stringify({ resourceType: 'NewMessage', resource }) };
  const frame = parseFrame(`3:12+::${JSON.stringify(envelope)}`);
  assert.equal(frame.kind, 'request');
  assert.equal(frame.kind === 'request' ? frame.ack : null, '12');
  const event = frame.kind === 'request' ? chatEvent(frame.envelope) : null;
  assert.equal(event?.name, 'NewMessage');
  assert.equal(event?.resource.id, '6000');
  assert.equal(parseFrame('3:::not json').kind, 'other');
});

test('typing posts a Control/Typing to the conversation, and a clear when it stops', async () => {
  const { calls, client } = fake(() => ({ status: 201, body: {} }));
  const dir = new TeamsDirectory();
  dir.remember(ME, 'Me');
  await typingAction(client, dir, SESSION, RID, true);
  await typingAction(client, dir, SESSION, RID, false);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.ok(posts[0].url.endsWith('/messages'), posts[0].url);
  assert.equal(posts[0].body?.messagetype, 'Control/Typing');
  assert.equal(posts[0].body?.content, '');
  assert.equal(posts[1].body?.messagetype, 'Control/ClearTyping');
});

test('the Teams provider advertises typing', () => {
  assert.equal(TEAMS_CAPABILITIES.typing, true);
});
