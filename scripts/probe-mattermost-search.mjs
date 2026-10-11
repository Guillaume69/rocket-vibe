// Disposable local bench only. Seed it first with scripts/seed-mattermost.mjs.
import assert from 'node:assert/strict';
import { createMattermostProvider } from '../apps/mobile/providers/mattermost/index.ts';
import { RestClient } from '../apps/mobile/lib/rest.ts';

const base = (process.env.MM_URL ?? 'http://127.0.0.1:8065').replace(/\/+$/, '');
assert.ok(['localhost', '127.0.0.1', '10.0.2.2'].includes(new URL(base).hostname), 'Use a disposable local Mattermost bench.');
const password = process.env.MM_PASSWORD ?? 'Rv-bench-2026!';
let token;
async function call(method, path, body) {
  const response = await fetch(`${base}/api/v4${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${value?.id ?? ''}`);
  return { value, response };
}
const login = await call('POST', '/users/login', { login_id: 'rvadmin', password });
token = login.response.headers.get('token');
assert.ok(token);
const me = login.value;
const team = (await call('GET', '/teams/name/rv')).value;
const publicRoom = (await call('GET', `/teams/${team.id}/channels/name/dev`)).value;
const privateRoom = (await call('GET', `/teams/${team.id}/channels/name/secret`)).value;
const floodRoom = (await call('GET', `/teams/${team.id}/channels/name/off-topic`)).value;
const bob = (await call('GET', '/users/username/bob')).value;
const carol = (await call('GET', '/users/username/carol')).value;
const dm = (await call('POST', '/channels/direct', [me.id, bob.id])).value;
const group = (await call('POST', '/channels/group', [me.id, bob.id, carol.id])).value;
const self = (await call('POST', '/channels/direct', [me.id, me.id])).value;
const marker = `rvsearch${Date.now()}`;
const created = [];
const cases = [
  ['public', publicRoom, 'dev'], ['private', privateRoom, 'secret'],
  ['DM', dm, '@bob'], ['group', group, '@rvadmin,bob,carol'], ['self-DM', self, '@rvadmin'],
];
const mobile = createMattermostProvider({ baseUrl: base, kind: 'mattermost', userId: me.id, username: me.username, authToken: token, siteUrl: null }, new RestClient(base), () => 'unused-probe-id');
try {
  for (const [, room] of cases) {
    const post = (await call('POST', '/posts', { channel_id: room.id, message: `${marker} target` })).value;
    created.push(post.id);
  }
  for (let n = 0; n < 120; n++) {
    const post = (await call('POST', '/posts', { channel_id: floodRoom.id, message: `${marker} noise ${n}` })).value;
    created.push(post.id);
  }
  const search = async terms => (await call('POST', `/teams/${team.id}/posts/search`, { terms, is_or_search: false, page: 0, per_page: 60 })).value;
  const unscoped = await search(marker);
  const unscopedIds = unscoped.order ?? [];
  assert.equal(unscopedIds.includes(created[2]), false, 'Bench must reproduce the old DM starvation.');
  console.log(`unscoped: ${unscopedIds.length} hits; older DM target missing`);
  for (let i = 0; i < cases.length; i++) {
    const [label, room, scope] = cases[i];
    const result = await search(`${marker} in:${scope}`);
    assert.deepEqual(result.order, [created[i]], `${label}: exact target`);
    assert.equal(result.posts[created[i]].channel_id, room.id);
    assert.deepEqual((await mobile.searchMessages(room.id, marker)).map(post => post.id), [created[i]], `${label}: actual mobile provider`);
    console.log(`${label}: 1 exact hit using in:${scope}`);
  }
  console.log('ALL OK: server scopes and actual mobile provider find every older room target');
} finally {
  for (const id of created) await call('DELETE', `/posts/${id}`);
  await call('POST', '/users/logout');
}
