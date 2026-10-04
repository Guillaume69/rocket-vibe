// Enables or disables bob's TOTP, for flow 05.
//
//   node e2e/harness/two-factor.mjs enable   -> prints the base32 SECRET
//   node e2e/harness/two-factor.mjs disable <SECRET>
//
// The `2fa:*` DDP methods have no REST equivalent: this TEST harness is the
// only place in the repo allowed to make DDP `method` calls; it simulates
// what bob's official app would do, it is not part of the client.

import { totp } from './totp.mjs';

const BASE = process.env.ROOT_URL ?? 'http://localhost:3000';
const action = process.argv[2];
const givenSecret = process.argv[3];

// Rocket.Chat REFUSES reuse of an already consumed code (the flow just used
// one), and only accepts ±1 window: depending on alignment, a single attempt
// can land right on the consumed code. So we try several windows until one
// succeeds.
const WINDOWS_MS = [30_000, 0, -30_000, 60_000];
async function tryWindows(secret, attempt) {
  let last;
  for (const offset of WINDOWS_MS) {
    try {
      return await attempt(totp(secret, Date.now() + offset));
    } catch (e) {
      last = e;
      console.error(`  window ${offset / 1000}s refused: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  throw last;
}

// If 2FA is ALREADY active (cleanup after an interrupted run), the plain
// login answers totp-required: we replay with the code computed from the secret.
async function loginBob() {
  const simple = await fetch(`${BASE}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026' }),
  });
  const body = await simple.json();
  if (body.data) return body.data;
  // `/login` puts the error code in `error` (not `errorType`).
  if ((body.error === 'totp-required' || body.errorType === 'totp-required') && givenSecret) {
    return tryWindows(givenSecret, async (code) => {
      const withCode = await fetch(`${BASE}/api/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026', code }),
      });
      const c = await withCode.json();
      if (!c.data) throw new Error(c.error ?? 'code refused');
      return c.data;
    });
  }
  return undefined;
}

const bob = await loginBob();
if (!bob) {
  console.error('bob login failed');
  process.exit(1);
}

const ws = new WebSocket(`${BASE.replace(/^http/i, 'ws')}/websocket`);
let id = 0;
const pending = new Map();
const call = (method, ...params) =>
  new Promise((resolve, reject) => {
    const mid = `m${++id}`;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ msg: 'method', method, id: mid, params }));
  });

ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.msg === 'ping') return ws.send(JSON.stringify({ msg: 'pong' }));
  if (m.msg === 'connected') {
    await call('login', { resume: bob.authToken });
    try {
      if (action === 'enable') {
        const { secret } = await call('2fa:enable');
        await call('2fa:validateTempToken', totp(secret));
        // `process.exit` does not wait for asynchronous writes to a pipe: the
        // secret would sometimes be TRUNCATED in `$(...)`, and lost.
        await new Promise((r) => process.stdout.write(`${secret}\n`, () => r()));
      } else if (action === 'disable') {
        if (!givenSecret) throw new Error('disable requires the secret');
        await tryWindows(givenSecret, (code) => call('2fa:disable', code));
        console.log('ok');
      } else {
        throw new Error('usage: two-factor.mjs enable | disable <SECRET>');
      }
      process.exit(0);
    } catch (err) {
      console.error(String(err?.message ?? err));
      process.exit(1);
    }
  }
  if (m.msg === 'result') {
    const wait = pending.get(m.id);
    if (!wait) return;
    pending.delete(m.id);
    if (m.error) wait.reject(new Error(m.error.message ?? 'method refused'));
    else wait.resolve(m.result);
  }
};
ws.onopen = () => ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
setTimeout(() => {
  console.error('timed out');
  process.exit(1);
}, 20000);
