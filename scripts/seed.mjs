#!/usr/bin/env node
// Fills the development Rocket.Chat server with test data.
//
//   node scripts/seed.mjs
//
// Idempotent, even after a partial failure: every seeded message carries a
// `[seed i/n]` marker, and only the missing markers are posted again. A script
// killed after 7 messages out of 12 resumes at the eighth.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CUSTOM_EMOJIS } from './emojis-seed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MESSAGE_COUNT = 12;
const REPLY_COUNT = 3;
const THREAD_ROOT = '[seed fil] Racine du fil de discussion.';

const messageText = (i, label) =>
  `[seed ${i}/${MESSAGE_COUNT}] Message de test dans ${label}. **gras**, _italique_, \`code\`.`;
const replyText = (i) => `[seed fil ${i}/${REPLY_COUNT}] Réponse dans le fil.`;

const RE_MESSAGE = /^\[seed (\d+)\/\d+\]/;
const RE_REPLY = /^\[seed fil (\d+)\/\d+\]/;

/**
 * Reads a `.env` file with no external dependency.
 * Surrounding quotes are stripped: `KEY="value"` is a common form, and keeping
 * it as is produces an invalid URL.
 * End-of-line comments are not handled: a `#` can legitimately appear in a
 * password.
 */
function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${path} not found. Copy docker/.env.example to docker/.env.`);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = readEnvFile(join(ROOT, 'docker', '.env'));

// The `.env` is authoritative: the credentials come from it. A ROOT_URL exported
// in the shell and pointing elsewhere would attempt a login on one server with
// another's credentials.
const BASE = (env.ROOT_URL || '').replace(/\/$/, '');
if (!BASE) throw new Error('ROOT_URL missing from docker/.env.');
if (process.env.ROOT_URL && process.env.ROOT_URL.replace(/\/$/, '') !== BASE) {
  process.stderr.write(
    `warning: $ROOT_URL (${process.env.ROOT_URL}) differs from docker/.env (${BASE}).\n` +
      `         docker/.env wins, since it also carries the credentials.\n`,
  );
}

const auth = { token: '', userId: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the REST API. Retries on 429: `API_Enable_Rate_Limiter` is on by default
 * and caps every endpoint. The server gives the reset time in
 * `x-ratelimit-reset` (epoch ms); failing that we fall back to an exponential
 * delay.
 */
async function api(method, endpoint, body, attempt = 0) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) {
    headers['X-Auth-Token'] = auth.token;
    headers['X-User-Id'] = auth.userId;
  }

  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    // `Number(null)` is 0, so a missing header gives waitMs = 0 and falls back
    // to the exponential delay, the same path as an already expired header.
    const waitMs = Number.isFinite(reset) ? Math.max(reset - Date.now(), 0) : 0;
    const delay = waitMs > 0 ? waitMs + 250 : 1000 * 2 ** attempt;
    process.stderr.write(`  429 on ${endpoint}, waiting ${Math.round(delay)} ms\n`);
    await res.body?.cancel();
    await sleep(delay);
    return api(method, endpoint, body, attempt + 1);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint}: non-JSON response (${res.status}) ${text.slice(0, 120)}`);
  }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

async function must(method, endpoint, body) {
  const r = await api(method, endpoint, body);
  if (!r.ok) throw new Error(`${endpoint} failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json;
}

async function login() {
  const j = await must('POST', 'login', { user: env.ADMIN_USERNAME, password: env.ADMIN_PASS });
  auth.token = j.data.authToken;
  auth.userId = j.data.userId;
  console.log(`logged in as ${env.ADMIN_USERNAME} (${j.data.me.roles.join(', ')})`);
}

async function ensureUser({ username, name, password }) {
  const found = await api('GET', `users.info?username=${encodeURIComponent(username)}`);
  if (found.ok) {
    console.log(`  user ${username}: already exists`);
    return found.json.user._id;
  }
  const j = await must('POST', 'users.create', {
    username,
    name,
    password,
    email: `${username}@rocket-vibe.test`,
    // `verified: false` on purpose. Rocket.Chat only enables email 2FA on a
    // verified address: a verified user can no longer log in in dev, for lack
    // of a mail server to receive the code.
    // Step 3.2's 2FA is tested by enrolling a TOTP, not by email.
    verified: false,
    requirePasswordChange: false,
    joinDefaultChannels: false,
    sendWelcomeEmail: false,
  });
  console.log(`  user ${username}: created`);
  return j.user._id;
}

/** `kind` is "channels" (public) or "groups" (private). */
async function ensureRoom(kind, name, members) {
  const key = kind === 'channels' ? 'channel' : 'group';
  const kindLabel = kind === 'channels' ? 'channel' : 'group';
  const found = await api('GET', `${kind}.info?roomName=${encodeURIComponent(name)}`);
  if (found.ok) {
    console.log(`  ${kindLabel} ${name}: already exists`);
    return found.json[key]._id;
  }
  const j = await must('POST', `${kind}.create`, { name, members });
  console.log(`  ${kindLabel} ${name}: created`);
  return j[key]._id;
}

/** `im.create` is already idempotent server-side. */
async function ensureIm(username) {
  const j = await must('POST', 'im.create', { username });
  console.log(`  direct message with ${username}: ready`);
  return j.room._id;
}

async function history(historyEndpoint, roomId) {
  const j = await must('GET', `${historyEndpoint}?roomId=${roomId}&count=100`);
  return j.messages || [];
}

/** Indices already present among the messages carrying the seed marker. */
function presentIndices(messages, regex) {
  const seen = new Set();
  for (const m of messages) {
    const found = regex.exec(m.msg || '');
    if (found) seen.add(Number(found[1]));
  }
  return seen;
}

/**
 * Posts only the missing messages again. A partially seeded room is completed,
 * never left as is nor duplicated.
 */
async function seedMessages(historyEndpoint, roomId, label) {
  const messages = await history(historyEndpoint, roomId);
  const present = presentIndices(
    messages.filter((m) => !m.tmid),
    RE_MESSAGE,
  );
  const missing = [];
  for (let i = 1; i <= MESSAGE_COUNT; i++) if (!present.has(i)) missing.push(i);

  if (missing.length === 0) {
    console.log(`  messages of ${label}: ${MESSAGE_COUNT}/${MESSAGE_COUNT}, nothing to do`);
    return;
  }
  for (const i of missing) {
    await must('POST', 'chat.postMessage', { roomId, text: messageText(i, label) });
  }
  console.log(`  messages of ${label}: ${missing.length} posted, total ${MESSAGE_COUNT}`);
}

/**
 * The thread is checked independently of the room's messages. Tying it to "we
 * just posted the messages" would make it impossible to create on a room that
 * already has them.
 */
async function seedThread(historyEndpoint, roomId) {
  const messages = await history(historyEndpoint, roomId);
  let root = messages.find((m) => m.msg === THREAD_ROOT && !m.tmid);
  if (!root) {
    const j = await must('POST', 'chat.postMessage', { roomId, text: THREAD_ROOT });
    root = j.message;
    console.log('  thread: root created');
  }

  const thread = await must('GET', `chat.getThreadMessages?tmid=${root._id}&count=50`);
  const present = presentIndices(thread.messages || [], RE_REPLY);
  const missing = [];
  for (let i = 1; i <= REPLY_COUNT; i++) if (!present.has(i)) missing.push(i);

  if (missing.length === 0) {
    console.log(`  thread: ${REPLY_COUNT}/${REPLY_COUNT} replies, nothing to do`);
    return;
  }
  for (const i of missing) {
    await must('POST', 'chat.sendMessage', {
      message: { rid: roomId, tmid: root._id, msg: replyText(i) },
    });
  }
  console.log(`  thread: ${missing.length} reply(ies) posted, total ${REPLY_COUNT}`);
}

/**
 * Posts `emoji-custom.create` (multipart). `must`/`api` only do JSON, hence this
 * direct `fetch`, but it RETRIES on 429 like `api`, otherwise a burst of emojis
 * would die under the rate limiter where the rest of the seed waits. The
 * `FormData` is rebuilt on every attempt (its body is consumed).
 */
async function createCustomEmoji(e, attempt = 0) {
  // `atob` rather than `Buffer`: a standard global the RN lint knows.
  const bytes = Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.set('emoji', new Blob([bytes], { type: e.type }), `${e.name}.${e.ext}`);
  fd.set('name', e.name);
  fd.set('aliases', e.aliases);
  const res = await fetch(`${BASE}/api/v1/emoji-custom.create`, {
    method: 'POST',
    headers: { 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId },
    body: fd,
  });
  if (res.status === 429 && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const waitMs = Number.isFinite(reset) ? Math.max(reset - Date.now(), 0) : 0;
    const delay = waitMs > 0 ? waitMs + 250 : 1000 * 2 ** attempt;
    process.stderr.write(`  429 on emoji-custom.create, waiting ${Math.round(delay)} ms\n`);
    await res.body?.cancel();
    await sleep(delay);
    return createCustomEmoji(e, attempt + 1);
  }
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`emoji-custom.create ${e.name}: (${res.status}) ${JSON.stringify(json)}`);
  }
}

/**
 * Custom emojis. `emoji-custom.create` rejects a name already taken: we list
 * first, and create only the missing ones.
 */
async function seedCustomEmojis() {
  const list = await must('GET', 'emoji-custom.list');
  const existing = new Set((list.emojis?.update ?? []).map((e) => e.name));
  for (const e of CUSTOM_EMOJIS) {
    if (existing.has(e.name)) {
      console.log(`  emoji ${e.name}: already exists`);
      continue;
    }
    await createCustomEmoji(e);
    console.log(`  emoji ${e.name}: created`);
  }
}

async function main() {
  console.log(`server: ${BASE}`);
  await login();

  console.log('users');
  await ensureUser({ username: 'alice', name: 'Alice Martin', password: 'alice-dev-2026' });
  await ensureUser({ username: 'bob', name: 'Bob Durand', password: 'bob-dev-2026' });

  console.log('rooms');
  const publicId = await ensureRoom('channels', 'test-public', ['alice', 'bob']);
  const privateId = await ensureRoom('groups', 'test-prive', ['alice']);
  const dmId = await ensureIm('alice');

  console.log('custom emojis');
  await seedCustomEmojis();

  console.log('messages');
  await seedMessages('channels.history', publicId, 'test-public');
  await seedMessages('groups.history', privateId, 'test-prive');
  await seedMessages('im.history', dmId, 'le direct avec alice');
  await seedThread('channels.history', publicId);

  console.log('\ndone.');
}

main().catch((e) => {
  // `fetch` hides the real cause (ECONNREFUSED, DNS…) in `e.cause`.
  process.stderr.write(`\nseed failed: ${e.message}\n`);
  if (e.cause) process.stderr.write(`cause : ${e.cause}\n`);
  process.exit(1);
});
