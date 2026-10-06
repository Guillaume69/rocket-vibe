#!/usr/bin/env node
/**
 * What the Rocket.Chat → RocketVibe import must carry over, on top of
 * `scripts/seed.mjs`: reactions, a pin, stars, an edited and a deleted
 * message, a quote, a mention, uploaded files, a topic, a favorite, read
 * positions and a user avatar. Run after `seed.mjs`; idempotent (each item is
 * found by its marker text before being made again).
 *
 *   node scripts/seed-import.mjs
 */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'docker/.env'), 'utf8')
    .split('\n')
    .map((l) => /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')]),
);
const BASE = (env.ROOT_URL || '').replace(/\/$/, '');
if (!BASE) throw new Error('ROOT_URL missing from docker/.env.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A signed-in account; REST calls retry on 429 like seed.mjs. */
async function session(user, password) {
  const auth = {};
  const call = async (method, endpoint, body, attempt = 0) => {
    const headers = auth.token ? { 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId } : {};
    const form = body instanceof FormData;
    if (body && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
      method,
      headers,
      body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
    if (res.status === 429 && attempt < 6) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() + 250 : 1000 * 2 ** attempt;
      process.stderr.write(`  429 on ${endpoint}, waiting ${Math.round(wait)} ms\n`);
      await res.body?.cancel();
      await sleep(wait);
      return call(method, endpoint, body, attempt + 1);
    }
    const json = await res.json();
    if (!res.ok || json.success === false) throw new Error(`${endpoint} (${res.status}): ${JSON.stringify(json)}`);
    return json;
  };
  const j = await call('POST', 'login', { user, password });
  auth.token = j.data.authToken;
  auth.userId = j.data.userId;
  return { call, userId: j.data.userId };
}

const admin = await session(env.ADMIN_USERNAME, env.ADMIN_PASS);
const alice = await session('alice', 'alice-dev-2026');
const bob = await session('bob', 'bob-dev-2026');

const channel = (await admin.call('GET', 'channels.info?roomName=test-public')).channel;
const rid = channel._id;
const historyOf = async () => (await admin.call('GET', `channels.history?roomId=${rid}&count=200`)).messages;
let messages = await historyOf();
const byText = (prefix) => messages.find((m) => typeof m.msg === 'string' && m.msg.startsWith(prefix));
async function post(who, text, extra = {}) {
  const found = byText(text);
  if (found) return found;
  const sent = (await who.call('POST', 'chat.sendMessage', { message: { rid, msg: text, ...extra } })).message;
  messages = await historyOf();
  return sent;
}

console.log(`server: ${BASE}, room test-public (${rid})`);

// Reactions from two people on one message, one on another.
const first = byText('[seed 1/') ?? messages[messages.length - 1];
const second = byText('[seed 2/') ?? messages[messages.length - 2];
for (const [who, msg, emoji] of [[admin, first, ':thumbsup:'], [alice, first, ':thumbsup:'], [bob, second, ':tada:']]) {
  const already = msg.reactions?.[emoji]?.usernames?.length && (await who.call('GET', `chat.getMessage?msgId=${msg._id}`)).message.reactions?.[emoji]?.usernames;
  const me = who === admin ? env.ADMIN_USERNAME : who === alice ? 'alice' : 'bob';
  if (!already?.includes(me)) await who.call('POST', 'chat.react', { messageId: msg._id, emoji, shouldReact: true });
}
console.log('  reactions: ready');

// A pinned message and two stars.
const pinned = await post(admin, '[import pin] Message épinglé.');
if (!(await admin.call('GET', `chat.getMessage?msgId=${pinned._id}`)).message.pinned) {
  await admin.call('POST', 'chat.pinMessage', { messageId: pinned._id });
}
for (const who of [alice, bob]) await who.call('POST', 'chat.starMessage', { messageId: pinned._id });
console.log('  pin and stars: ready');

// Edited and deleted messages.
const edited = await post(alice, '[import edit] Avant modification.');
if (!edited.editedAt) {
  await alice.call('POST', 'chat.update', { roomId: rid, msgId: edited._id, text: '[import edit] Après modification.' });
}
if (!byText('[import delete]') && !messages.some((m) => m.t === 'rm')) {
  const doomed = await post(bob, '[import delete] Ce message sera supprimé.');
  await bob.call('POST', 'chat.delete', { roomId: rid, msgId: doomed._id });
}
console.log('  edit and delete: ready');

// A mention and a quote (permalink to an earlier message).
await post(bob, '[import mention] Salut @alice, tu as vu ?');
await post(alice, `[import quote] [ ](${BASE}/channel/test-public?msg=${first._id}) Je cite ce message.`);
console.log('  mention and quote: ready');

// Files: an image and a text document, through the two-step upload.
async function upload(who, name, type, bytes, caption) {
  if (messages.some((m) => m.file?.name === name)) return;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const media = await who.call('POST', `rooms.media/${rid}`, form);
  await who.call('POST', `rooms.mediaConfirm/${rid}/${media.file._id}`, { msg: caption });
  messages = await historyOf();
}
/** A small solid PNG, encoded here rather than pasted. */
function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const png = solidPng(64, [255, 95, 162]);
await upload(alice, 'import-pixel.png', 'image/png', png, '[import file] Une image.');
await upload(bob, 'import-notes.txt', 'text/plain', Buffer.from('Notes pour l’import.\n'), '[import file] Un document.');
console.log('  files: ready');

// Room settings, a favorite, a read position.
if (channel.topic !== 'Le sujet importé') {
  await admin.call('POST', 'channels.setTopic', { roomId: rid, topic: 'Le sujet importé' });
}
if (channel.description !== 'Une description à importer.') {
  await admin.call('POST', 'channels.setDescription', { roomId: rid, description: 'Une description à importer.' });
}
await alice.call('POST', 'rooms.favorite', { roomId: rid, favorite: true });
await bob.call('POST', 'subscriptions.read', { rid });
console.log('  topic, favorite, read: ready');

// A user avatar (alice), uploaded as an image.
const aliceInfo = (await admin.call('GET', 'users.info?username=alice')).user;
if (!aliceInfo.avatarETag) {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'avatar.png');
  await alice.call('POST', 'users.setAvatar', form);
}
console.log('  avatar: ready');
console.log('\ndone.');
