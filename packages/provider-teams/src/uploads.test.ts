import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from '@rocket-vibe/provider-api/session';
import type { TransportUpload, UploadRow, UploadStore } from '@rocket-vibe/provider-api/uploads';
import { TeamsTokens, type TeamsRoutes } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsDirectory } from './translate.ts';
import { TeamsUploadQueue } from './uploads.ts';

type Doc = Record<string, unknown>;

const ME = '8:orgid:me';
const RID = '19:c@thread.tacv2';
const CHAT = 'https://emea.ng.msg.teams.microsoft.com';
const ROUTES: TeamsRoutes = {
  chat: CHAT, aggregator: 'https://teams.microsoft.com/api/csa/emea', trouter: 'https://go.trouter.teams.microsoft.com',
  registrar: 'https://teams.microsoft.com/registrar/prod', ams: 'https://eu-api.asm.skype.com', middleTier: 'https://teams.microsoft.com/api/mt/emea', presence: 'https://presence.teams.microsoft.com', search: 'https://fr-prod.asyncgw.teams.microsoft.com/msgsearch',
};
const SESSION = {
  baseUrl: 'https://teams.microsoft.com', authToken: 'fixture', userId: ME, username: 'Me', kind: 'teams', siteUrl: null,
  teamsTenantId: 'tenant', teamsRefresh: 'fixture-refresh',
} as Session;

const WEB_URL = 'https://axxonefr757.sharepoint.com/sites/Test/Shared%20Documents/a.png';
const SITE = 'https://axxonefr757.sharepoint.com/sites/Test';

/** A fetcher answering the Graph discovery and the chat-service send. */
function fake() {
  const calls: { method: string; url: string; body: Doc | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? (JSON.parse(init.body) as Doc) : null;
    calls.push({ method, url, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 'graph-fixture', expires_in: 3600 });
    if (url.endsWith('/me/joinedTeams?$select=id')) return json({ value: [{ id: 'group-1' }] });
    if (url.endsWith('/teams/group-1/channels?$select=id')) return json({ value: [{ id: RID }] });
    if (url.includes('/channels/') && url.includes('/filesFolder')) return json({ id: 'folder-1', parentReference: { driveId: 'drive-1' } });
    if (url.includes('/drives/drive-1/items/folder-1:/') && !url.endsWith('/content')) {
      return json({ id: 'item-1', name: 'a.png', webUrl: WEB_URL, sharepointIds: { siteUrl: SITE, listItemUniqueId: 'uniq-1' } });
    }
    if (url.includes('/conversations/') && url.endsWith('/messages')) return json({ OriginalArrivalTime: 1792800000000 });
    return json({}, 404);
  }) as typeof fetch;
  const client = new TeamsClient(TeamsTokens.preset(SESSION, ROUTES, 'skype-fixture', 'bearer-fixture', { fetch: fetcher }), { fetch: fetcher });
  return { calls, client };
}

/** An in-memory upload table. */
function memoryStore() {
  const rows = new Map<string, UploadRow>();
  const store: UploadStore = {
    insert: async (l) => void rows.set(l.id, { ...l, status: 'pending', fileId: null }),
    listToSend: async () => [...rows.values()].filter((l) => l.status === 'pending'),
    claim: async (id) => { const l = rows.get(id); if (!l || l.status !== 'pending') return false; l.status = 'sending'; return true; },
    rearmInFlight: async (here) => { for (const l of rows.values()) if (l.status === 'sending' && !here.includes(l.id)) l.status = 'pending'; },
    rearm: async (id) => { const l = rows.get(id); if (l) l.status = 'pending'; },
    recordFileId: async (id, fileId) => { const l = rows.get(id); if (l) l.fileId = fileId; },
    fileAlreadyPosted: async () => false,
    markFailed: async (id) => { const l = rows.get(id); if (l) l.status = 'failed'; },
    delete: async (id) => void rows.delete(id),
  };
  return { store, rows };
}

test('a Teams file uploads to the channel folder and posts a properties.files message', async () => {
  const { calls, client } = fake();
  const { store, rows } = memoryStore();
  const puts: { url: string; auth: string | undefined }[] = [];
  const transport: TransportUpload = async (url, headers) => {
    puts.push({ url, auth: headers.authorization });
    return { status: 201, body: '' };
  };
  const directory = new TeamsDirectory();
  directory.remember(ME, 'Me');
  const ingested: Doc[] = [];
  const queue = new TeamsUploadQueue({
    store, client, transport, directory, me: ME, generateId: () => 'row-1', ingest: async (d) => void ingested.push(d),
  });

  await queue.send(RID, { uri: 'file:///tmp/a.png', name: 'a.png', type: 'image/png', size: 10 });

  // The bytes went to the channel's Graph drive folder, with the Graph bearer.
  const put = puts[0];
  assert.ok(put, 'a binary upload happened');
  assert.ok(put.url.includes('/drives/drive-1/items/folder-1:/a.png:/content'), put.url);
  assert.equal(put.auth, 'Bearer graph-fixture');
  // The message carried the file as properties.files, pointing at its SharePoint url.
  const send = calls.find((c) => c.method === 'POST' && c.url.endsWith('/messages'));
  assert.ok(send, 'a message was posted');
  const files = JSON.parse((send!.body!.properties as Doc).files as string) as Doc[];
  assert.equal(files.length, 1);
  assert.equal((files[0].fileInfo as Doc).fileUrl, WEB_URL);
  assert.equal(files[0].fileName, 'a.png');
  // The row settled (no failure left behind).
  assert.equal(rows.size, 0);
});
