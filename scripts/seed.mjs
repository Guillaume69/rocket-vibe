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

import { EMOJIS_CUSTOM } from './emojis-seed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const NB_MESSAGES = 12;
const NB_REPONSES = 3;
const RACINE_FIL = '[seed fil] Racine du fil de discussion.';

const texteMessage = (i, label) =>
  `[seed ${i}/${NB_MESSAGES}] Message de test dans ${label}. **gras**, _italique_, \`code\`.`;
const texteReponse = (i) => `[seed fil ${i}/${NB_REPONSES}] Réponse dans le fil.`;

const RE_MESSAGE = /^\[seed (\d+)\/\d+\]/;
const RE_REPONSE = /^\[seed fil (\d+)\/\d+\]/;

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
  const cle = kind === 'channels' ? 'channel' : 'group';
  const libelle = kind === 'channels' ? 'channel' : 'group';
  const found = await api('GET', `${kind}.info?roomName=${encodeURIComponent(name)}`);
  if (found.ok) {
    console.log(`  ${libelle} ${name}: already exists`);
    return found.json[cle]._id;
  }
  const j = await must('POST', `${kind}.create`, { name, members });
  console.log(`  ${libelle} ${name}: created`);
  return j[cle]._id;
}

/** `im.create` is already idempotent server-side. */
async function ensureIm(username) {
  const j = await must('POST', 'im.create', { username });
  console.log(`  direct message with ${username}: ready`);
  return j.room._id;
}

async function historique(historyEndpoint, roomId) {
  const j = await must('GET', `${historyEndpoint}?roomId=${roomId}&count=100`);
  return j.messages || [];
}

/** Indices already present among the messages carrying the seed marker. */
function indicesPresents(messages, regex) {
  const vus = new Set();
  for (const m of messages) {
    const found = regex.exec(m.msg || '');
    if (found) vus.add(Number(found[1]));
  }
  return vus;
}

/**
 * Posts only the missing messages again. A partially seeded room is completed,
 * never left as is nor duplicated.
 */
async function seedMessages(historyEndpoint, roomId, label) {
  const messages = await historique(historyEndpoint, roomId);
  const presents = indicesPresents(
    messages.filter((m) => !m.tmid),
    RE_MESSAGE,
  );
  const manquants = [];
  for (let i = 1; i <= NB_MESSAGES; i++) if (!presents.has(i)) manquants.push(i);

  if (manquants.length === 0) {
    console.log(`  messages of ${label}: ${NB_MESSAGES}/${NB_MESSAGES}, nothing to do`);
    return;
  }
  for (const i of manquants) {
    await must('POST', 'chat.postMessage', { roomId, text: texteMessage(i, label) });
  }
  console.log(`  messages of ${label}: ${manquants.length} posted, total ${NB_MESSAGES}`);
}

/**
 * The thread is checked independently of the room's messages. Tying it to "we
 * just posted the messages" would make it impossible to create on a room that
 * already has them.
 */
async function seedThread(historyEndpoint, roomId) {
  const messages = await historique(historyEndpoint, roomId);
  let racine = messages.find((m) => m.msg === RACINE_FIL && !m.tmid);
  if (!racine) {
    const j = await must('POST', 'chat.postMessage', { roomId, text: RACINE_FIL });
    racine = j.message;
    console.log('  thread: root created');
  }

  const fil = await must('GET', `chat.getThreadMessages?tmid=${racine._id}&count=50`);
  const presents = indicesPresents(fil.messages || [], RE_REPONSE);
  const manquants = [];
  for (let i = 1; i <= NB_REPONSES; i++) if (!presents.has(i)) manquants.push(i);

  if (manquants.length === 0) {
    console.log(`  thread: ${NB_REPONSES}/${NB_REPONSES} replies, nothing to do`);
    return;
  }
  for (const i of manquants) {
    await must('POST', 'chat.sendMessage', {
      message: { rid: roomId, tmid: racine._id, msg: texteReponse(i) },
    });
  }
  console.log(`  thread: ${manquants.length} reply(ies) posted, total ${NB_REPONSES}`);
}

/**
 * Posts `emoji-custom.create` (multipart). `must`/`api` only do JSON, hence this
 * direct `fetch`, but it RETRIES on 429 like `api`, otherwise a burst of emojis
 * would die under the rate limiter where the rest of the seed waits. The
 * `FormData` is rebuilt on every attempt (its body is consumed).
 */
async function creerEmojiCustom(e, attempt = 0) {
  // `atob` rather than `Buffer`: a standard global the RN lint knows.
  const octets = Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.set('emoji', new Blob([octets], { type: e.type }), `${e.name}.${e.ext}`);
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
    return creerEmojiCustom(e, attempt + 1);
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
async function seedEmojisCustom() {
  const liste = await must('GET', 'emoji-custom.list');
  const existants = new Set((liste.emojis?.update ?? []).map((e) => e.name));
  for (const e of EMOJIS_CUSTOM) {
    if (existants.has(e.name)) {
      console.log(`  emoji ${e.name}: already exists`);
      continue;
    }
    await creerEmojiCustom(e);
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
  const priveId = await ensureRoom('groups', 'test-prive', ['alice']);
  const dmId = await ensureIm('alice');

  console.log('custom emojis');
  await seedEmojisCustom();

  console.log('messages');
  await seedMessages('channels.history', publicId, 'test-public');
  await seedMessages('groups.history', priveId, 'test-prive');
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
