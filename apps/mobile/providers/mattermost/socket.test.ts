import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent, WebSocketLike } from '../../lib/ddp.ts';
import { MmSocket } from './socket.ts';

/** A socket the test drives: `sent` collects frames, `serve` pushes one in. */
function fakeWs(answer: (frame: Record<string, unknown>, ws: FakeWs) => void = () => {}) {
  const sockets: FakeWs[] = [];
  const create = (url: string): WebSocketLike => {
    const ws = new FakeWs(url, answer);
    sockets.push(ws);
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
  return { create, sockets };
}

class FakeWs implements WebSocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  private readonly answer: (frame: Record<string, unknown>, ws: FakeWs) => void;
  constructor(url: string, answer: (frame: Record<string, unknown>, ws: FakeWs) => void) {
    this.url = url;
    this.answer = answer;
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    queueMicrotask(() => this.answer(frame, this));
  }
  close(): void {
    this.onclose?.({});
  }
  serve(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const ok = (frame: Record<string, unknown>, ws: FakeWs) => ws.serve({ status: 'OK', seq_reply: frame.seq, data: { text: 'pong' } });

describe('MmSocket', () => {
  test('authenticates with the token and arms at once', async () => {
    const { create, sockets } = fakeWs(ok);
    const socket = new MmSocket('ws://mm.test/api/v4/websocket', async () => [], { createWebSocket: create, heartbeatMs: 60_000 });
    await socket.connect('tok');
    assert.equal(socket.state, 'authenticated');
    assert.deepEqual(sockets[0]?.sent[0], { seq: 1, action: 'authentication_challenge', data: { token: 'tok' } });
    await socket.armedSubscriptions();
    socket.close();
  });

  test('a refused challenge fails the connection and closes it', async () => {
    const { create } = fakeWs((frame, ws) => ws.serve({ status: 'FAIL', seq_reply: frame.seq, error: { id: 'api.web_socket_router.not_authenticated.app_error' } }));
    const socket = new MmSocket('ws://x', async () => [], { createWebSocket: create });
    await assert.rejects(socket.connect('bad'));
    assert.equal(socket.state, 'closed');
  });

  test('events go through expansion, one at a time, in arrival order', async () => {
    const { create, sockets } = fakeWs(ok);
    const order: string[] = [];
    const socket = new MmSocket('ws://x', async (name) => {
      if (name === 'slow') await new Promise((r) => setTimeout(r, 20));
      return [{ collection: name, eventKey: '', args: [] }];
    }, { createWebSocket: create, heartbeatMs: 60_000 });
    socket.onEvent((e: DdpEvent) => order.push(e.collection));
    await socket.connect('tok');
    sockets[0]!.serve({ event: 'slow', data: {}, broadcast: {} });
    sockets[0]!.serve({ event: 'fast', data: {}, broadcast: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(order, ['slow', 'fast']);
    socket.close();
  });

  test('a ping answered keeps the socket; a closed socket reports a loss, a purposeful close does not', async () => {
    const { create, sockets } = fakeWs(ok);
    const socket = new MmSocket('ws://x', async () => [], { createWebSocket: create, heartbeatMs: 60_000 });
    let losses = 0;
    socket.onLoss(() => losses++);
    await socket.connect('tok');
    assert.equal(await socket.checkAlive(), true);
    sockets[0]!.close();
    assert.equal(losses, 1);
    await socket.connect('tok');
    socket.close();
    assert.equal(losses, 1);
  });
});
