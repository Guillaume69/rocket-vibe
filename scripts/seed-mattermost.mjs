#!/usr/bin/env node
// Fills the development Mattermost server with test data.
//
//   node scripts/seed-mattermost.mjs
//
// Idempotent like `seed.mjs`: users, team and channels are looked up before
// being created, and every seeded post carries a `[seed i/n]` marker so a rerun
// only posts the missing ones.

const URL_BASE = (process.env.MM_URL ?? 'http://localhost:8065').replace(/\/+$/, '');
const PASSWORD = process.env.MM_PASSWORD ?? 'Rv-bench-2026!';
const USERS = [
  { username: 'rvadmin', email: 'rvadmin@bench.invalid', first_name: 'Ada', last_name: 'Admin' },
  { username: 'bob', email: 'bob@bench.invalid', first_name: 'Bob', last_name: 'Builder' },
  { username: 'carol', email: 'carol@bench.invalid', first_name: 'Carol', last_name: 'Coder' },
];
const TEAM = { name: 'rv', display_name: 'RocketVibe bench', type: 'O' };
const CHANNELS = [
  { name: 'dev', display_name: 'Dev', type: 'O' },
  { name: 'secret', display_name: 'Secret', type: 'P' },
];
const MESSAGE_COUNT = 12;
const REPLY_COUNT = 3;
const THREAD_ROOT = '[seed thread] Root of the discussion thread.';
const RE_MESSAGE = /^\[seed (\d+)\/\d+\]/;
const RE_REPLY = /^\[seed thread (\d+)\/\d+\]/;

async function call(method, path, token, body) {
  const response = await fetch(`${URL_BASE}/api/v4${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${json?.id ?? ''} ${json?.message ?? text}`);
    error.status = response.status;
    error.id = json?.id;
    throw error;
  }
  return { json, headers: response.headers };
}

async function login(username) {
  const { json, headers } = await call('POST', '/users/login', null, { login_id: username, password: PASSWORD });
  return { token: headers.get('token'), user: json };
}

async function ensureUser(spec, adminToken) {
  try {
    await call('POST', '/users', adminToken, { ...spec, password: PASSWORD });
  } catch (e) {
    if (e.status !== 400) throw e;
  }
  return (await login(spec.username)).user;
}

async function ensureTeam(token) {
  try {
    return (await call('GET', `/teams/name/${TEAM.name}`, token)).json;
  } catch (e) {
    if (e.status !== 404) throw e;
    return (await call('POST', '/teams', token, TEAM)).json;
  }
}

async function ensureChannel(spec, team, token) {
  try {
    return (await call('GET', `/teams/${team.id}/channels/name/${spec.name}`, token)).json;
  } catch (e) {
    if (e.status !== 404) throw e;
    return (await call('POST', '/channels', token, { ...spec, team_id: team.id })).json;
  }
}

async function addToTeam(team, user, token) {
  await call('POST', `/teams/${team.id}/members`, token, { team_id: team.id, user_id: user.id }).catch((e) => {
    if (e.status !== 400) throw e;
  });
}

async function addToChannel(channel, user, token) {
  await call('POST', `/channels/${channel.id}/members`, token, { user_id: user.id }).catch((e) => {
    if (e.status !== 400) throw e;
  });
}

async function existing(channel, token) {
  const { json } = await call('GET', `/channels/${channel.id}/posts?per_page=200`, token);
  return json.order.map((id) => json.posts[id]);
}

async function seedPosts(channel, label, token) {
  const posts = await existing(channel, token);
  const present = new Set(posts.map((p) => RE_MESSAGE.exec(p.message)?.[1]).filter(Boolean).map(Number));
  for (let i = 1; i <= MESSAGE_COUNT; i++) {
    if (present.has(i)) continue;
    await call('POST', '/posts', token, {
      channel_id: channel.id,
      message: `[seed ${i}/${MESSAGE_COUNT}] Test message in ${label}. **bold**, _italic_, \`code\`.`,
    });
  }
  let root = posts.find((p) => p.message === THREAD_ROOT);
  if (!root) root = (await call('POST', '/posts', token, { channel_id: channel.id, message: THREAD_ROOT })).json;
  const replies = new Set(
    posts.filter((p) => p.root_id === root.id).map((p) => RE_REPLY.exec(p.message)?.[1]).filter(Boolean).map(Number),
  );
  for (let i = 1; i <= REPLY_COUNT; i++) {
    if (replies.has(i)) continue;
    await call('POST', '/posts', token, {
      channel_id: channel.id,
      root_id: root.id,
      message: `[seed thread ${i}/${REPLY_COUNT}] Reply in the thread.`,
    });
  }
}

async function main() {
  // The first account created on a fresh server becomes system admin.
  let admin;
  try {
    admin = await login(USERS[0].username);
  } catch {
    await call('POST', '/users', null, { ...USERS[0], password: PASSWORD });
    admin = await login(USERS[0].username);
  }
  const users = [admin.user];
  for (const spec of USERS.slice(1)) users.push(await ensureUser(spec, admin.token));
  const team = await ensureTeam(admin.token);
  for (const user of users) await addToTeam(team, user, admin.token);
  const channels = [];
  for (const spec of CHANNELS) {
    const channel = await ensureChannel(spec, team, admin.token);
    for (const user of users) await addToChannel(channel, user, admin.token);
    channels.push(channel);
  }
  const townSquare = (await call('GET', `/teams/${team.id}/channels/name/town-square`, admin.token)).json;
  for (const channel of [townSquare, ...channels]) await seedPosts(channel, channel.display_name, admin.token);
  const dm = (await call('POST', '/channels/direct', admin.token, [admin.user.id, users[1].id])).json;
  const bob = await login(users[1].username);
  await seedPosts(dm, 'DM', bob.token);
  console.log(`Seeded ${URL_BASE}: team ${team.name}, users ${users.map((u) => u.username).join(', ')}, password ${PASSWORD}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
