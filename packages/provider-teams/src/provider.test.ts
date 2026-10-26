import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from '@rocket-vibe/provider-api/session';
import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import type { OutboxRow, OutboxStore } from '@rocket-vibe/provider-api/outbox';
import type { SyncEngine } from '@rocket-vibe/provider-api/sync';
import { TeamsTokens, type TeamsRoutes } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox, clientMessageId } from './outbox.ts';
import { TEAMS_EVENTS, THREAD_COUNTERS, TeamsRooms, TeamsSync, TeamsThreads, TeamsTranslator } from './sync.ts';
import { TeamsDirectory } from './translate.ts';
import { chatEvent, parseFrame } from './trouter.ts';
import { TEAMS_CAPABILITIES, teamsPinned, typingAction } from './index.ts';
import { teamsCalls } from './calls.ts';

type Doc = Record<string, unknown>;
type Call = { method: string; url: string; body: Doc | null; headers: Record<string, string> };

const ME = '8:orgid:me';
const RID = '19:c@thread.v2';
const CHAT = 'https://emea.ng.msg.teams.microsoft.com';
const ROUTES: TeamsRoutes = {
  chat: CHAT, aggregator: 'https://teams.microsoft.com/api/csa/emea', trouter: 'https://go.trouter.teams.microsoft.com',
  registrar: 'https://teams.microsoft.com/registrar/prod', ams: 'https://eu-api.asm.skype.com', middleTier: 'https://teams.microsoft.com/api/mt/emea', presence: 'https://presence.teams.microsoft.com', search: 'https://fr-prod.asyncgw.teams.microsoft.com/msgsearch',
};
const SESSION: Session = {
  baseUrl: 'https://teams.microsoft.com', authToken: 'fixture', userId: ME, username: 'Me', kind: 'teams', siteUrl: null,
  teamsTenantId: 'tenant', teamsRefresh: 'fixture-refresh',
} as Session;

/** A fetch answering from `route`, recording each call. */
function fake(route: (call: Call) => { status?: number; body?: unknown } | 'throw', clientOptions: { me?: string; isChat?: (rid: string) => boolean } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET', url: String(input),
      body: typeof init?.body === 'string' && init.body.startsWith('{') ? (JSON.parse(init.body) as Doc) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const answer = route(call);
    if (answer === 'throw') throw new TypeError('network down');
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  const client = new TeamsClient(TeamsTokens.preset(SESSION, ROUTES, 'skype-fixture', 'bearer-fixture', { fetch: fetcher }), { fetch: fetcher, ...clientOptions });
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

test('the read horizon passes the events the aggregator lists last', async () => {
  const { calls, client } = fake(() => ({ body: {} }));
  const actions = new TeamsMessageActions(client, async () => {});
  assert.equal(await actions.markRead(RID, `${RID}/500`, 700), 700);
  assert.equal(await actions.markRead(RID, null, 700), null);
  assert.equal(await actions.markRead(RID, null, 900), 900);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((p) => String(p.body?.consumptionhorizon).split(';')[0]), ['700', '900']);
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

test('a thread reply is sent to the root message target', async () => {
  const rowId = 'fedcba9876543210fedcba98';
  const marker = clientMessageId(rowId);
  const root = `${RID}/900`;
  const { calls, client } = fake((call) => call.method === 'POST'
    ? { status: 201, body: {} }
    : { body: { messages: [message('950', { clientmessageid: marker, from: `${CHAT}/v1/users/ME/contacts/${ME}` })] } });
  const { store } = outboxStore();
  const outbox = new TeamsOutbox({ store, client, directory: new TeamsDirectory(), me: { id: ME, username: 'Me' }, generateId: () => rowId, ingest: async () => {} });
  await outbox.send(RID, 'in the thread', root);
  const post = calls.find((c) => c.method === 'POST')!;
  assert.ok(decodeURIComponent(post.url).includes(`${RID};messageid=900/messages`), post.url);
});

test('the Teams provider advertises threads', () => {
  assert.equal(TEAMS_CAPABILITIES.threads, true);
});

test('a post counts the replies read with it, and a live reply moves its count', async () => {
  const CH = '19:ch@thread.tacv2';
  const reply = (id: string) => message(id, { conversationLink: `${CHAT}/v1/users/ME/conversations/${CH};messageid=1000` });
  const { client } = fake(() => ({ body: { messages: [reply('1200'), reply('1100'), message('1000')] } }));
  const threads = new TeamsThreads();
  const translator = new TeamsTranslator(new TeamsDirectory(), ME, threads);
  const stored = new Map<string, LocalMessage>();
  const counters: [string, number, number | null][] = [];
  const store = {
    ingestMessages: async (docs: Doc[]) => { for (const d of docs) { const m = translator.toMessage(d); if (m) stored.set(m.id, m); } },
    syncStore: { deleteMessage: async () => {}, updateThreadCounters: async (id: string, n: number, last: number | null) => { counters.push([id, n, last]); } },
  } as unknown as SyncEngine;
  await new TeamsSync(client, new TeamsRooms(), threads).loadHistory(store, CH);
  assert.deepEqual(counters, [[`${CH}/1000`, 2, 1200]]);
  assert.deepEqual([stored.get(`${CH}/1000`)?.threadCount, stored.get(`${CH}/1100`)?.threadId], [2, `${CH}/1000`]);

  const live = translator.toMessage({ ...reply('1300'), __rid: CH });
  assert.equal(live?.threadId, `${CH}/1000`);
  const moved = translator.translateEvent({ collection: TEAMS_EVENTS, eventKey: THREAD_COUNTERS, args: [{ id: `${CH}/1000` }] });
  assert.deepEqual(moved, { kind: 'change', change: { type: 'thread-counters', id: `${CH}/1000`, count: 3, last: 1300 } });
  const gone = translator.translateEvent({ collection: TEAMS_EVENTS, eventKey: 'MessageUpdate', args: [{ ...reply('1300'), properties: { deletetime: 1 } }] });
  assert.equal(gone.kind, 'change');
  assert.deepEqual(threads.counters(`${CH}/1000`), { count: 2, last: 1200 });
  assert.equal(translator.toMessage({ ...message('1000'), __rid: CH })?.threadCount, 2, 'a post read again keeps its count');
});

test('loading a thread fetches the root and the thread-scoped conversation', async () => {
  const root = `${RID}/900`;
  const seen: string[] = [];
  const { calls, client } = fake((call) => {
    seen.push(decodeURIComponent(call.url));
    return { body: { messages: [message('901'), message('902')] } };
  });
  const ingested: Doc[] = [];
  const engine = { ingestMessages: async (docs: Doc[]) => { ingested.push(...docs); }, syncStore: { deleteMessage: async () => {} } } as unknown as SyncEngine;
  const sync = new TeamsSync(client, new TeamsRooms());
  await sync.loadThread(engine, root);
  assert.ok(seen.some((u) => u.includes(`${RID}/messages/900`)), 'root fetched');
  assert.ok(seen.some((u) => u.includes(`${RID};messageid=900/messages`)), seen.join('\n'));
  assert.ok(ingested.length >= 2);
});

test('a pin POSTs to the CSA aggregator under the parent team; unpin DELETEs', async () => {
  const { calls, client } = fake(() => ({ status: 201, body: {} }));
  const actions = new TeamsMessageActions(client, async () => {});
  await actions.setPinned('19:team@thread.tacv2', RID, `${RID}/500`, true);
  await actions.setPinned('19:team@thread.tacv2', RID, `${RID}/500`, false);
  const pin = calls.find((c) => c.method === 'POST' && c.url.includes('/pin'));
  const unpin = calls.find((c) => c.method === 'DELETE' && c.url.includes('/pin'));
  assert.ok(pin, 'a POST to .../pin');
  assert.ok(pin!.url.endsWith('/csa/emea/api/v1/teams/19:team@thread.tacv2/channels/19:c@thread.v2/posts/500/pin'), pin!.url);
  assert.equal((pin!.headers as Record<string, string>).authorization, 'Bearer bearer-fixture');
  assert.ok(unpin, 'a DELETE to .../pin');
});

test('a call opens the conversation in Teams: a channel through its Graph group, a chat directly', async () => {
  const channel = '19:ch@thread.tacv2';
  const { calls, client } = fake((call) => {
    if (call.url.includes('/oauth2/v2.0/token')) return { body: { access_token: 'graph-fixture', expires_in: 3600 } };
    if (call.url.endsWith('/me/joinedTeams?$select=id')) return { body: { value: [{ id: 'group-1' }] } };
    if (call.url.endsWith('/teams/group-1/channels?$select=id')) return { body: { value: [{ id: channel }] } };
    return { status: 404, body: {} };
  });
  const rooms = new TeamsRooms();
  rooms.entries.set(channel, { entry: { id: channel, displayName: 'General' }, team: { id: '19:team@thread.tacv2', name: 'Team' } });
  const teams = teamsCalls(client, rooms, 'tenant-1');
  assert.equal(
    await teams.start(channel, null, () => true),
    'https://teams.microsoft.com/l/channel/19%3Ach%40thread.tacv2/General?groupId=group-1&tenantId=tenant-1',
  );
  const before = calls.length;
  assert.equal(await teams.join(RID, {}, () => true), 'https://teams.microsoft.com/l/chat/19%3Ac%40thread.v2/conversations?tenantId=tenant-1');
  assert.equal(calls.length, before, 'a chat link needs no call');
  assert.equal(TEAMS_CAPABILITIES.videoCall, true);
});

test('a channel call card joins the call itself, its starter as organizer', async () => {
  const channel = '19:ch@thread.tacv2';
  const { calls, client } = fake((call) => {
    if (call.url.includes('/conversations/') && call.url.includes('/messages/1792769688903')) {
      return { body: { id: '1792769688903', messagetype: 'Event/Call', from: 'https://x/v1/users/ME/contacts/8:orgid:oid-1' } };
    }
    return { status: 404, body: {} };
  });
  const rooms = new TeamsRooms();
  rooms.entries.set(channel, { entry: { id: channel, displayName: 'General', groupId: 'group-1' }, team: { id: '19:team@thread.tacv2', name: 'Team' } });
  const teams = teamsCalls(client, rooms, 'tenant-1');
  assert.equal(
    await teams.join(`${channel}/1792769688903`, {}, () => true),
    'https://teams.microsoft.com/l/meetup-join/19%3ach%40thread.tacv2/1792769688903?context=%7B%22Tid%22%3A%22tenant-1%22%2C%22Oid%22%3A%22oid-1%22%7D',
  );
  const before = calls.length;
  assert.equal(
    await teams.start(channel, null, () => true),
    'https://teams.microsoft.com/l/channel/19%3Ach%40thread.tacv2/General?groupId=group-1&tenantId=tenant-1',
  );
  assert.equal(calls.length, before, 'the entry carries the group id');
});

test('a channel is renamed through the templates service with its own token', async () => {
  const { calls, client } = fake((call) => {
    if (call.url.includes('/oauth2/v2.0/token')) return { body: { access_token: 'templates-fixture', expires_in: 3600 } };
    if (call.url.includes('/fabric/')) return { body: {} };
    return { status: 404, body: {} };
  });
  await client.rename('group-1', 'oid-1', 'tenant-1', 'Ops');
  const patch = calls.find((c) => c.url.includes('/fabric/'));
  assert.ok(patch, 'a PATCH to the fabric templates route');
  assert.equal(patch!.method, 'PATCH');
  assert.ok(patch!.url.endsWith('/fabric/emea/templates/api/teams/group-1/channels/OID:oid-1@tenant-1?forceSync=false'), patch!.url);
  assert.equal((patch!.headers as Record<string, string>).authorization, 'Bearer templates-fixture');
});

test('the Teams provider lists pinned messages but has no saves', async () => {
  assert.deepEqual([TEAMS_CAPABILITIES.marks, TEAMS_CAPABILITIES.stars], [true, false]);
  const pin = '{"creatorId":"8:orgid:aaa","pinnedTime":1}';
  const { client } = fake((call) => call.url.includes('/messages?') ? { body: { messages: [
    { id: '100', messagetype: 'RichText/Html', content: 'old', from: '8:orgid:aaa', originalarrivaltime: '2026-10-23T10:00:00Z', properties: { pinned: pin } },
    { id: '200', messagetype: 'RichText/Html', content: 'not pinned', from: '8:orgid:aaa', originalarrivaltime: '2026-10-23T11:00:00Z' },
    { id: '300', messagetype: 'RichText/Html', content: 'new', from: '8:orgid:aaa', originalarrivaltime: '2026-10-23T12:00:00Z', properties: { pinned: pin } },
  ] } } : { status: 404, body: {} });
  const listed = await teamsPinned(client, new TeamsDirectory(), RID);
  assert.deepEqual(listed.map((m) => m.id), [`${RID}/300`, `${RID}/100`]);
});

test('downloadUrl resolves a SharePoint share to the pre-signed Graph download url', async () => {
  const shareUrl = 'https://contoso.sharepoint.com/sites/x/report.pdf';
  const { calls, client } = fake((call) => {
    if (call.url.includes('/oauth2/v2.0/token')) return { body: { access_token: 'graph-fixture', expires_in: 3600 } };
    if (call.url.includes('/shares/u!') && call.url.endsWith('/driveItem')) {
      return { body: { '@microsoft.graph.downloadUrl': 'https://presigned.example/download' } };
    }
    return { status: 404, body: {} };
  });
  assert.equal(await client.downloadUrl(shareUrl), 'https://presigned.example/download');
  const driveItem = calls.find((c) => c.url.includes('/shares/u!'));
  assert.ok(driveItem, 'the /shares/driveItem endpoint was called');
  assert.match(String((driveItem!.headers as Record<string, string>).authorization ?? ''), /^Bearer /);
  // An unresolvable driveItem leaves the url unchanged.
  const { client: c2 } = fake((call) =>
    call.url.includes('/oauth2/v2.0/token') ? { body: { access_token: 'g', expires_in: 3600 } } : { body: {} });
  assert.equal(await c2.downloadUrl(shareUrl), shareUrl);
});

test('a chat file goes to my OneDrive chat files folder and is shared with the chat, no mail', async () => {
  const { calls, client } = fake((call) => {
    if (call.url.includes('/oauth2/v2.0/token')) return { body: { access_token: 'graph-fixture', expires_in: 3600 } };
    if (call.url.includes('/me/drive/root:/Microsoft%20Teams%20Chat%20Files?')) return { body: { id: 'F', parentReference: { driveId: 'D' } } };
    if (call.url.includes('/drives/D/items/F:/note.txt?')) {
      return { body: { id: 'I', name: 'note.txt', webUrl: 'https://c-my.sharepoint.com/personal/me/Documents/Microsoft Teams Chat Files/note.txt', sharepointIds: { siteUrl: 'https://c-my.sharepoint.com/personal/me', listItemUniqueId: 'U' } } };
    }
    if (call.url.includes(`/threads/${encodeURIComponent(RID).replace(/%3A/gi, ':').replace(/%40/g, '@')}`)) return { body: { members: [{ id: ME }, { id: '8:orgid:bob' }, { id: '28:bot' }] } };
    if (call.url.endsWith('/drives/D/items/I/invite')) return { body: { value: [{ id: 'p' }] } };
    return { status: 404, body: {} };
  }, { me: ME, isChat: () => true });
  assert.ok((await client.contentUrl(RID, 'note.txt')).endsWith('/drives/D/items/F:/note.txt:/content'));
  const ref = await client.fileRef(RID, 'note.txt');
  assert.deepEqual([ref.itemId, ref.site, ref.unique], ['I', 'https://c-my.sharepoint.com/personal/me', 'U']);
  const invite = calls.find((c) => c.url.endsWith('/invite'));
  assert.deepEqual(invite?.body, { requireSignIn: true, sendInvitation: false, roles: ['read'], recipients: [{ objectId: 'bob' }] });
});
