#!/usr/bin/env node
// Throwaway DDP spike, step 1.7.
//
//   node scripts/spike-ddp.mjs
//
// Proves the realtime path end to end against the local Docker server, and
// settles uncertainty #2 of ROADMAP.md §7: do private streams require an
// authenticated DDP session (`method login {resume}`) on top of REST
// authentication?
//
// Protocol: we open TWO WebSocket connections. The first does NOT log in over
// DDP and tries to subscribe to stream-room-messages on a private room; the
// second logs in then subscribes to the same streams. We then post a message
// through REST and watch who receives what.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node 22+'s GLOBAL WebSocket, on purpose: it is the same browser API
// (onopen/onmessage/onerror) as React Native's. The spike therefore validates
// exactly the code the app will use, not that of `ws`.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`${path} not found. Copy docker/.env.example to docker/.env.`);
    process.exit(1);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = readEnvFile(join(ROOT, 'docker', '.env'));
if (!env.ROOT_URL) {
  console.error('ROOT_URL missing from docker/.env.');
  process.exit(1);
}
const BASE = env.ROOT_URL.replace(/\/$/, '');
const WS_URL = `${BASE.replace(/^http/, 'ws')}/websocket`;

// ---------------------------------------------------------------------------
// REST: admin login + locating the test rooms.
// ---------------------------------------------------------------------------
async function rest(method, endpoint, auth, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    headers['X-Auth-Token'] = auth.token;
    headers['X-User-Id'] = auth.userId;
  }
  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`${endpoint} -> ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Throwaway mini DDP client. Enough for connect / login / sub / events.
// ---------------------------------------------------------------------------
class SpikeDDP {
  constructor(name) {
    this.name = name;
    this.counter = 0;
    this.pending = new Map(); // id -> {resolve, reject} of in-flight subs/methods
    this.events = []; // `changed` messages received on the streams
    this.entries = [];
  }

  log(...args) {
    const line = `[${this.name}] ${args.join(' ')}`;
    this.entries.push(line);
    console.log(line);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.onerror = (e) => reject(new Error(`websocket: ${e.message ?? 'error'}`));
      this.ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)), resolve);
      this.ws.onopen = () => {
        this.sendFrame({ msg: 'connect', version: '1', support: ['1'] });
      };
    });
  }

  sendFrame(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  receive(m, onConnected) {
    switch (m.msg) {
      case 'connected':
        this.log('DDP session open:', m.session);
        onConnected?.(m.session);
        break;
      case 'ping':
        this.sendFrame({ msg: 'pong', ...(m.id ? { id: m.id } : {}) });
        break;
      case 'result': {
        const waiter = this.pending.get(m.id);
        if (waiter) {
          this.pending.delete(m.id);
          m.error ? waiter.reject(new Error(JSON.stringify(m.error))) : waiter.resolve(m.result);
        }
        break;
      }
      case 'ready':
        for (const id of m.subs) {
          const waiter = this.pending.get(id);
          if (waiter) {
            this.pending.delete(id);
            waiter.resolve('ready');
          }
        }
        break;
      case 'nosub': {
        const waiter = this.pending.get(m.id);
        if (waiter) {
          this.pending.delete(m.id);
          waiter.reject(new Error(`nosub: ${JSON.stringify(m.error ?? '(no error)')}`));
        }
        break;
      }
      case 'changed':
        // Streamer format: collection = stream name, fields.eventName = key,
        // fields.args = payload.
        this.events.push(m);
        this.log(
          'event:',
          m.collection,
          '|',
          m.fields?.eventName,
          '|',
          JSON.stringify(m.fields?.args?.[0]?.msg ?? m.fields?.args?.[0] ?? null).slice(0, 80),
        );
        break;
      default:
        // updated, added… of no interest to the spike.
        break;
    }
  }

  callMethod(method, ...params) {
    const id = `m${++this.counter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame({ msg: 'method', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`method ${method}: no result within 5 s`));
      }, 5000);
    });
  }

  subscribe(name, ...params) {
    const id = `s${++this.counter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame({ msg: 'sub', id, name, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`sub ${name}: neither ready nor nosub within 5 s`));
      }, 5000);
    });
  }

  close() {
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// The spike's protocol.
// ---------------------------------------------------------------------------
async function main() {
  console.log(`server: ${BASE}\nwebsocket: ${WS_URL}\n`);

  const admin = await rest('POST', 'login', null, {
    user: env.ADMIN_USERNAME,
    password: env.ADMIN_PASS,
  });
  const auth = { token: admin.data.authToken, userId: admin.data.userId };
  console.log(`REST: logged in as ${env.ADMIN_USERNAME}\n`);

  const privateRoom = await rest('GET', 'groups.info?roomName=test-prive', auth);
  const publicCh = await rest('GET', 'channels.info?roomName=test-public', auth);
  const ridPrivate = privateRoom.group._id;
  const ridPublic = publicCh.channel._id;
  console.log(`private room: test-prive  (${ridPrivate})`);
  console.log(`public room:  test-public (${ridPublic})\n`);

  const verdicts = [];
  // An anonymous sub ACCEPTED on a private room must fail the spike, even if no
  // event leaks during the observation window.
  let anonymousPrivateSubAccepted = false;

  // --- Connection A: NO DDP login -----------------------------------------
  const anonymous = new SpikeDDP('anonymous');
  await anonymous.connect();

  try {
    await anonymous.subscribe('stream-room-messages', ridPrivate, { useCollection: false, args: [] });
    anonymousPrivateSubAccepted = true;
    verdicts.push('ANONYMOUS + private room: sub ACCEPTED (ready), LEAK, the spike fails');
  } catch (e) {
    verdicts.push(`ANONYMOUS + private room: sub REFUSED (${e.message.slice(0, 60)})`);
  }
  try {
    await anonymous.subscribe('stream-room-messages', ridPublic, { useCollection: false, args: [] });
    verdicts.push('ANONYMOUS + public room: sub accepted (ready)');
  } catch (e) {
    verdicts.push(`ANONYMOUS + public room: sub refused (${e.message.slice(0, 60)})`);
  }

  // --- Connection B: DDP login with a resume token -------------------------
  const connected = new SpikeDDP('logged-in');
  await connected.connect();
  const loginResult = await connected.callMethod('login', { resume: auth.token });
  connected.log('DDP login accepted, userId =', loginResult.id);
  verdicts.push('DDP LOGIN with {resume: <REST authToken>}: ACCEPTED, the same token serves both');

  await connected.subscribe('stream-room-messages', ridPrivate, { useCollection: false, args: [] });
  connected.log('sub stream-room-messages (private): ready');
  await connected.subscribe('stream-notify-user', `${auth.userId}/subscriptions-changed`, {
    useCollection: false,
    args: [],
  });
  connected.log('sub stream-notify-user subscriptions-changed: ready');

  // --- The trigger: a message posted through REST -------------------------
  const marker = `spike-ddp ${new Date().toISOString()}`;
  await rest('POST', 'chat.postMessage', auth, { roomId: ridPrivate, text: marker });
  console.log(`\nREST: message posted in test-prive ("${marker}")\n`);

  // Two seconds to let the events arrive.
  await new Promise((r) => setTimeout(r, 2000));

  const received = connected.events.some(
    (m) =>
      m.collection === 'stream-room-messages' &&
      m.fields?.args?.some?.((a) => a?.msg === marker),
  );
  verdicts.push(
    received
      ? 'LOGGED IN: the REST message arrived through stream-room-messages, realtime proven'
      : 'LOGGED IN: message NOT received, realtime path to diagnose',
  );

  const receivedAnonymous = anonymous.events.some((m) => m.collection === 'stream-room-messages');
  verdicts.push(
    receivedAnonymous
      ? 'ANONYMOUS: received events, leak to report'
      : 'ANONYMOUS: no event received',
  );

  anonymous.close();
  connected.close();

  console.log('\n========== VERDICTS ==========');
  for (const v of verdicts) console.log(' •', v);

  const passed = received && !receivedAnonymous && !anonymousPrivateSubAccepted;
  console.log(passed ? '\nSPIKE: PASS' : '\nSPIKE: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('spike failed:', e.message);
  if (e.cause) console.error('cause:', e.cause);
  process.exit(1);
});
