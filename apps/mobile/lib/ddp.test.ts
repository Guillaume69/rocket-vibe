import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientDdp, DdpError, type DdpEvent, type WebSocketLike } from './ddp.ts';

/** In-memory WebSocket: we inspect what goes out, we inject what comes in. */
class FakeWebSocket implements WebSocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulates the TCP open. */
  open(): void {
    this.onopen?.(null);
  }

  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  receiveRaw(text: string): void {
    this.onmessage?.({ data: text });
  }

  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
}

/** Connects a client up to `authenticated`, answering like the server. */
async function authenticatedClient(): Promise<{ ddp: ClientDdp; ws: FakeWebSocket }> {
  const ws = new FakeWebSocket();
  const ddp = new ClientDdp('ws://x/websocket', { createWebSocket: () => ws, timeoutMs: 200 });
  const promise = ddp.connect('jeton-rest');
  ws.open();
  ws.receive({ msg: 'connected', session: 'sess-1' });
  // The client then sends `method login`.
  await new Promise((r) => setImmediate(r));
  const login = ws.last();
  ws.receive({ msg: 'result', id: login.id, result: { id: 'u1' } });
  await promise;
  return { ddp, ws };
}

describe('ClientDdp', () => {
  test('the DDP handshake is sent on open', async () => {
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton');
    ws.open();
    assert.deepEqual(ws.sent[0], { msg: 'connect', version: '1', support: ['1'] });

    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await p;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ddp.session, 's');
  });

  test('the DDP login uses the REST token through `resume`', async () => {
    const { ws } = await authenticatedClient();
    const login = ws.sent.find((m) => m.msg === 'method');
    assert.equal(login?.method, 'login');
    assert.deepEqual(login?.params, [{ resume: 'jeton-rest' }]);
  });

  test('a `failed` rejects the connection AND leaves the client reusable', async () => {
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('j');
    ws.open();
    ws.receive({ msg: 'failed', version: '2' });
    await assert.rejects(p, /DDP version refused/);
    assert.equal(ddp.state, 'closed', 'otherwise every retry fails on "already connected"');
    assert.equal(ws.closed, true);
  });

  test('the handshake TIMEOUT cleans up: the client stays reusable', async () => {
    // A proxy that accepts the WebSocket but whose backend is dead will never
    // send "connected" NOR close the socket: without cleanup, the state would
    // stay "connecting" forever and the reconnection driver would spin idle on
    // "already connected".
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 50 });
    const p = ddp.connect('j');
    ws.open();
    await assert.rejects(p, /No "connected"/);
    assert.equal(ddp.state, 'closed');
    assert.equal(ws.closed, true, 'the zombie socket is cut');
  });

  test('close() during the handshake rejects IMMEDIATELY', async () => {
    // The handshake lives outside `pending`: without a dedicated hook, this
    // scenario (quick screen unmount, StrictMode) hung until the timeout. The
    // one-minute timeout here proves we do NOT go through it.
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 60_000 });
    const p = ddp.connect('j');
    ws.open();
    ddp.close();
    await assert.rejects(p, DdpError);
    assert.equal(ddp.state, 'closed');
  });

  test('subscribing BEFORE authentication is deferred, then established on its own', async () => {
    // Regression: the old API threw here, the screen swallowed the error and
    // never retried; a room opened too early stayed deaf for life. It is the
    // exact path of a launch from a notification tap (6.2).
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x/websocket', { createWebSocket: () => ws, timeoutMs: 200 });
    ddp.subscribe('stream-room-messages', 'rid-1');
    assert.equal(ws.sent.length, 0, 'nothing goes out until authenticated');

    const promise = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await promise;

    const sub = ws.sent.find((m) => m.msg === 'sub');
    assert.ok(sub, 'the deferred subscription goes out on authentication');
    assert.equal(sub?.name, 'stream-room-messages');
    ws.receive({ msg: 'ready', subs: [sub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('a `sub` sends the streamer convention and waits for `ready`', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid-1');
    const sub = ws.last();
    assert.equal(sub.msg, 'sub');
    assert.equal(sub.name, 'stream-room-messages');
    assert.deepEqual(sub.params, ['rid-1', { useCollection: false, args: [] }]);
    assert.equal(ddp.subscriptionCount, 0, 'not established before the `ready`');

    ws.receive({ msg: 'ready', subs: [sub.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('`armedSubscriptions` waits for the server `ready`, not a delay', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid-1');
    ddp.subscribe('stream-notify-user', 'u1/rooms-changed');
    const [secondToLast, last] = ws.sent.slice(-2);

    let armed = false;
    const wait = ddp.armedSubscriptions().then(() => {
      armed = true;
    });

    // Only one of the two is ready: connection setup must NOT read yet, or the
    // other leaves a gap between the two transports.
    ws.receive({ msg: 'ready', subs: [secondToLast.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(armed, false);

    ws.receive({ msg: 'ready', subs: [last.id] });
    await wait;
    assert.equal(armed, true);
    assert.equal(ddp.subscriptionCount, 2);
  });

  test('`armedSubscriptions` also settles on a `nosub`, never blocking', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'prive');
    const sub = ws.last();

    const wait = ddp.armedSubscriptions();
    ws.receive({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });

    await wait; // does not reject: a refused room does not prevent reading
    assert.equal(ddp.subscriptionCount, 0);
  });

  test('`armedSubscriptions` settles when the socket dies mid-negotiation', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid-1');

    const wait = ddp.armedSubscriptions();
    ws.onclose?.(null); // drop while the `sub` is in flight

    await wait;
    assert.equal(ddp.state, 'closed');
  });

  test('a `nosub` does not count the subscription, but keeps it desired', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'prive');
    const sub = ws.last();
    ws.receive({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 0);
    assert.equal(ddp.wantedSubscriptionCount, 1, 'retried on the next authentication');
  });

  test('a `changed` is routed to the listeners', async () => {
    const { ddp, ws } = await authenticatedClient();
    const received: DdpEvent[] = [];
    ddp.onEvent((e) => received.push(e));

    ws.receive({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: 'rid-1', args: [{ msg: 'bonjour' }] },
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].collection, 'stream-room-messages');
    assert.equal(received[0].eventKey, 'rid-1');
    assert.deepEqual(received[0].args, [{ msg: 'bonjour' }]);
  });

  test('a throwing listener does not stop the others from receiving', async () => {
    const { ddp, ws } = await authenticatedClient();
    const received: string[] = [];
    ddp.onEvent(() => {
      throw new Error('boum');
    });
    ddp.onEvent((e) => received.push(e.eventKey));
    ws.receive({
      msg: 'changed',
      collection: 'c',
      fields: { eventName: 'k', args: [] },
    });
    assert.deepEqual(received, ['k']);
  });

  test('a `changed` without `eventName` is ignored, not fatal', async () => {
    const { ddp, ws } = await authenticatedClient();
    let received = 0;
    ddp.onEvent(() => received++);
    ws.receive({ msg: 'changed', collection: 'c', fields: { args: [] } });
    assert.equal(received, 0);
  });

  test('a `ping` gets a `pong`, with the `id` only if there was one', async () => {
    const { ws } = await authenticatedClient();
    ws.receive({ msg: 'ping' });
    assert.deepEqual(ws.last(), { msg: 'pong' });
    ws.receive({ msg: 'ping', id: 'p1' });
    assert.deepEqual(ws.last(), { msg: 'pong', id: 'p1' });
  });

  test('a non-JSON message does not crash the client', async () => {
    const { ddp, ws } = await authenticatedClient();
    ws.receiveRaw('<html>proxy</html>');
    assert.equal(ddp.state, 'authenticated');
  });

  test('releasing sends `unsub`; releasing twice is harmless', async () => {
    const { ddp, ws } = await authenticatedClient();
    const release = ddp.subscribe('stream-notify-user', 'u1/subscriptions-changed');
    const id = ws.last().id;
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));

    release();
    assert.deepEqual(ws.last(), { msg: 'unsub', id });
    assert.equal(ddp.subscriptionCount, 0);

    // Idempotent per caller: a double call does not steal another screen's
    // reference.
    const before = ws.sent.length;
    release();
    assert.equal(ws.sent.length, before);
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('releasing DURING the negotiation cuts the subscription on `ready`', async () => {
    const { ddp, ws } = await authenticatedClient();
    const release = ddp.subscribe('stream-room-messages', 'rid');
    const id = ws.last().id;
    release(); // the screen closes before the server answers
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ws.last(), { msg: 'unsub', id }, 'do not leak the subscription');
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('releasing AFTER a drop does not leak the reference', async () => {
    // Regression: `unsubscribe(id)` looked up the wire identifier, which the
    // drop had just erased; the counter never went down and the reconnection
    // would have replayed closed rooms forever.
    const { ddp, ws } = await authenticatedClient();
    const release = ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null); // the socket drops, the screen is still open
    release(); // then the screen closes
    assert.equal(ddp.wantedSubscriptionCount, 0, 'nothing left to replay in 5.1');
  });

  test('closing the socket lets the negotiation settle cleanly', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.onclose?.(null);
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.state, 'closed');
    assert.equal(ddp.subscriptionCount, 0);
    assert.equal(ddp.wantedSubscriptionCount, 1);
  });

  test('the liveness probe: pong = alive; silence = socket cleaned up and loss notified', async () => {
    const alive = await authenticatedClient();
    const p1 = alive.ddp.checkAlive();
    alive.ws.receive({ msg: 'pong', id: alive.ws.last().id });
    assert.equal(await p1, true);
    assert.equal(alive.ddp.state, 'authenticated');

    // Half-dead socket: never a pong, never a close.
    const zombie = await authenticatedClient(); // 200 ms timeout
    let losses = 0;
    zombie.ddp.onLoss(() => losses++);
    assert.equal(await zombie.ddp.checkAlive(), false);
    assert.equal(zombie.ddp.state, 'closed', 'the dead socket is cleaned up');
    assert.equal(losses, 1, 'the reconnection driver is notified');
  });

  test('onLoss fires on a drop, never on close()', async () => {
    // It is the reconnection driver's signal: firing it on `close()` would
    // trigger a reconnection right after the deliberate logout.
    const first = await authenticatedClient();
    let losses = 0;
    first.ddp.onLoss(() => losses++);
    first.ws.onclose?.(null);
    assert.equal(losses, 1);

    const second = await authenticatedClient();
    let voluntaryLosses = 0;
    second.ddp.onLoss(() => voluntaryLosses++);
    second.ddp.close();
    assert.equal(voluntaryLosses, 0);
  });

  test('on reconnection, the desired subscriptions are replayed', async () => {
    // Foundation of step 5.1: the drop erases the wire identifiers, not the
    // intentions. A new authentication restores everything.
    const sockets: FakeWebSocket[] = [];
    const ddp = new ClientDdp('ws://x/websocket', {
      createWebSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      timeoutMs: 200,
    });

    const p1 = ddp.connect('jeton');
    sockets[0].open();
    sockets[0].receive({ msg: 'connected', session: 's1' });
    await new Promise((r) => setImmediate(r));
    sockets[0].receive({ msg: 'result', id: sockets[0].last().id, result: {} });
    await p1;

    ddp.subscribe('stream-room-messages', 'rid');
    sockets[0].receive({ msg: 'ready', subs: [sockets[0].last().id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);

    sockets[0].onclose?.(null); // drop
    assert.equal(ddp.subscriptionCount, 0);

    const p2 = ddp.connect('jeton');
    sockets[1].open();
    sockets[1].receive({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].receive({ msg: 'result', id: sockets[1].last().id, result: {} });
    await p2;

    const resub = sockets[1].sent.find((m) => m.msg === 'sub');
    assert.ok(resub, 'the subscription goes out again without anyone asking');
    sockets[1].receive({ msg: 'ready', subs: [resub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('a refused login closes the socket and leaves the client reusable', async () => {
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton-mort');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, error: { error: 403, reason: 'login denied' } });

    await assert.rejects(p, /Method refused/);
    assert.equal(ddp.state, 'closed', 'otherwise a later connect() would throw "already connected"');
    assert.equal(ws.closed, true, 'the socket must not leak');
  });

  test('a socket dying during login notifies the loss only ONCE', async () => {
    // `onclose` cleans up and rejects the login wait; `connect()`'s `catch`
    // calls `cleanUp()` again. Without idempotence, every subscriber (drop
    // counter, offline banner, metric) counts double, and the second pass
    // re-emits the event on an already emptied object.
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    let losses = 0;
    ddp.onLoss(() => losses++);
    const p = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r)); // the `method login` has gone out
    ws.onclose?.(null); // the socket dies BEFORE the login answer

    await assert.rejects(p);
    assert.equal(losses, 1, 'one drop, one event');
    assert.equal(ddp.state, 'closed');
  });

  test('`checkAlive` during the NEGOTIATION does not probe and does not kill the socket', async () => {
    // Probed on a real Rocket.Chat 8.5: a `ping` sent before the `connect` gets
    // `{msg:'error', reason:'Must connect first'}`, never a `pong`. The wait
    // would hang until its timeout, and the `catch` would close a socket that
    // has meanwhile finished its login and replayed its subscriptions.
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 60 });
    const p = ddp.connect('jeton');
    ws.open();
    assert.equal(ddp.state, 'connecting');

    const before = ws.sent.length;
    assert.equal(await ddp.checkAlive(), false, 'a negotiation already has its own timeout');
    assert.equal(ws.sent.length, before, 'no ping goes out');

    // The negotiation completes normally, the socket is intact.
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await p;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ws.closed, false, 'the premature probe closed nothing');
  });

  test('`checkAlive` probes from the "connected" state, even before the login', async () => {
    // Checked on the 8.5.1 bench: `connect` then `ping` without login → `pong`.
    // So the guard must not be stricter than the server.
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.state, 'connected');

    const probe = ddp.checkAlive();
    const ping = ws.sent.filter((m) => m.msg === 'ping').at(-1);
    assert.ok(ping, 'the probe goes out');
    ws.receive({ msg: 'pong', id: ping.id });
    assert.equal(await probe, true);

    ws.receive({ msg: 'result', id: ws.sent.find((m) => m.msg === 'method')?.id, result: {} });
    await p;
  });

  test('a `msg: error` rejects the offending wait instead of letting it expire', async () => {
    // Shape recorded on the 8.5.1 bench:
    // {"msg":"error","reason":"Must connect first","offendingMessage":{"msg":"ping","id":"v1"}}
    // Without this case, the message is swallowed and the caller waits
    // `timeoutMs` for nothing; that silence is what made the premature probe
    // destructive.
    const { ddp, ws } = await authenticatedClient(); // 200 ms timeout
    const probe = ddp.checkAlive();
    const id = ws.last().id;

    ws.receive({ msg: 'error', reason: 'Must connect first', offendingMessage: { msg: 'ping', id } });

    // Without waiting for the 200 ms timeout: the answer must be immediate.
    assert.equal(await Promise.race([probe, new Promise((r) => setTimeout(() => r('pendante'), 60))]), false);
  });

  test('a `msg: error` without a usable `offendingMessage` is ignored, not fatal', async () => {
    const { ddp, ws } = await authenticatedClient();
    ws.receive({ msg: 'error', reason: 'Bad request' });
    assert.equal(ddp.state, 'authenticated');
  });

  test('two subscriptions to the same stream produce a single `sub` on the wire', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    const before = ws.sent.length;
    ddp.subscribe('stream-room-messages', 'rid');
    assert.equal(ws.sent.length, before, 'no extra `sub` goes out');
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('two `subscribe` in the same tick produce a single `sub` on the wire', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid');
    ddp.subscribe('stream-room-messages', 'rid');
    const subs = ws.sent.filter((m) => m.msg === 'sub');
    assert.equal(subs.length, 1, 'deduplication must also hold for in-flight `sub`s');

    ws.receive({ msg: 'ready', subs: [subs[0].id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('`unsub` is sent only when the last caller leaves', async () => {
    const { ddp, ws } = await authenticatedClient();
    const release1 = ddp.subscribe('stream-room-messages', 'rid');
    const id = ws.last().id;
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    const release2 = ddp.subscribe('stream-room-messages', 'rid');

    release1();
    assert.notEqual(ws.last().msg, 'unsub', 'one observer remains');
    assert.equal(ddp.subscriptionCount, 1);

    release2();
    assert.deepEqual(ws.last(), { msg: 'unsub', id });
    assert.equal(ddp.subscriptionCount, 0);
  });

  test('the desired subscriptions survive the socket going down', async () => {
    const { ddp, ws } = await authenticatedClient();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null);
    assert.equal(ddp.subscriptionCount, 0, 'nothing left on the wire');
    assert.equal(ddp.wantedSubscriptionCount, 1, 'step 5.1 must be able to replay it');

    ddp.reset();
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('an abandoned socket’s `close` does not break the next connection', async () => {
    // Bug found in integration: after a refused login, the old socket's
    // `onclose` arrived AFTER the new one opened and reset `this.ws` to null.
    // The `connect` never went out, and the reconnection expired without
    // explanation.
    const sockets: FakeWebSocket[] = [];
    const ddp = new ClientDdp('ws://x', {
      createWebSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      timeoutMs: 200,
    });

    const p1 = ddp.connect('jeton-mort');
    sockets[0].open();
    sockets[0].receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    sockets[0].receive({ msg: 'result', id: sockets[0].last().id, error: { error: 403 } });
    await assert.rejects(p1);

    const p2 = ddp.connect('bon-jeton');
    sockets[1].open();
    // The old socket reports its close, late.
    sockets[0].onclose?.(null);

    sockets[1].receive({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].receive({ msg: 'result', id: sockets[1].last().id, result: {} });
    await p2;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ddp.session, 's2');
  });

  test('an unanswered `sub` expires instead of hanging, and stays desired', async () => {
    const { ddp } = await authenticatedClient(); // 200 ms timeout
    ddp.subscribe('stream-room-messages', 'rid');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ddp.subscriptionCount, 0, 'never established');
    assert.equal(ddp.wantedSubscriptionCount, 1, 'retried on the next authentication');
  });
});

/**
 * A socket can die without `onclose` EVER being called (FIN received,
 * CLOSE-WAIT on the OS side, nothing in JS). Without a watchdog, the client
 * believes itself authenticated forever and no message arrives any more.
 */
describe('silence watchdog', () => {
  /** Like `authenticatedClient`, but with miniature guard thresholds. */
  async function guardedClient(): Promise<{ ddp: ClientDdp; ws: FakeWebSocket }> {
    const ws = new FakeWebSocket();
    const ddp = new ClientDdp('ws://x/websocket', {
      createWebSocket: () => ws,
      timeoutMs: 120,
      silenceMaxMs: 60,
      watchdogMs: 20,
    });
    const promise = ddp.connect('jeton-rest');
    ws.open();
    ws.receive({ msg: 'connected', session: 'sess-1' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: { id: 'u1' } });
    await promise;
    return { ddp, ws };
  }

  test('a silent socket is PROBED: the ping goes out on its own', async () => {
    const { ddp, ws } = await guardedClient();
    const before = ws.sent.length;

    await new Promise((r) => setTimeout(r, 110)); // exceeds the tolerated silence

    const pings = ws.sent.slice(before).filter((m) => m.msg === 'ping');
    assert.ok(pings.length >= 1, `the guard must probe, saw ${pings.length} ping`);
    ddp.close();
  });

  test('without a pong, the socket is declared dead and `onLoss` wakes the driver', async () => {
    const { ddp, ws } = await guardedClient();
    let losses = 0;
    ddp.onLoss(() => losses++);

    // Total silence: no traffic, no answer to the probe.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(ddp.state, 'closed', 'the dead socket is cleaned up');
    assert.equal(losses, 1, 'the loss is reported; without it, nothing reconnects');
    assert.ok(ws.closed, 'the socket is closed client-side');
  });

  test('a pinging server PUSHES BACK the guard: no probe on a live socket', async () => {
    const { ddp, ws } = await guardedClient();
    const before = ws.sent.length;

    // The server keeps its rhythm: a ping before each deadline.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40));
      ws.receive({ msg: 'ping' });
    }

    const probes = ws.sent.slice(before).filter((m) => m.msg === 'ping');
    assert.equal(probes.length, 0, 'no probe: server traffic is enough');
    assert.equal(ddp.state, 'authenticated');
    ddp.close();
  });

  test('ANY message counts as traffic, not just a ping', async () => {
    const { ddp, ws } = await guardedClient();
    const before = ws.sent.length;

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40));
      ws.receive({
        msg: 'changed',
        collection: 'stream-room-messages',
        fields: { eventName: 'rid', args: [{ _id: `m${i}` }] },
      });
    }

    assert.equal(ws.sent.slice(before).filter((m) => m.msg === 'ping').length, 0);
    assert.equal(ddp.state, 'authenticated');
    ddp.close();
  });

  test('`close()` stops the guard: no probe on a put-away client', async () => {
    const { ddp, ws } = await guardedClient();
    ddp.close();
    const before = ws.sent.length;

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(ws.sent.length, before, 'nothing goes out after closing');
  });
});
