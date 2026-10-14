import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent, WebSocketLike } from '../../lib/ddp.ts';
import { SlackClient } from './client.ts';
import { SlackRtm } from './rtm.ts';
import { AUTH, COOKIE, TOKEN, fakeSlack } from './testing.ts';

const RTM_URL = 'wss://wss-primary.slack-msgs.com/websocket/abc';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let n = 0; n < 50; n++) {
    const value = get();
    if (value !== undefined) return value;
    await tick();
  }
  throw new Error('timed out waiting');
}

class FakeWs implements WebSocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  readonly url: string;
  readonly headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  serve(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function harness(answer: Record<string, unknown> = { ok: true, team: { id: 'T000' }, self: { id: 'U000' }, url: RTM_URL }) {
  const sockets: FakeWs[] = [];
  const { fetcher } = fakeSlack((call) => (call.method === 'rtm.connect' ? { body: answer } : call.method === 'auth.test' ? { body: AUTH } : undefined));
  const client = new SlackClient(TOKEN, COOKIE, { fetch: fetcher, expected: { teamId: 'T000', userId: 'U000' } });
  const events: DdpEvent[] = [];
  const rtm = new SlackRtm(client, async (frame) => [{ collection: 'slack:message', eventKey: String(frame.channel ?? ''), args: [frame] }], {
    createSocket: (url, headers) => {
      const ws = new FakeWs(url, headers);
      sockets.push(ws);
      return ws;
    },
    timeoutMs: 50,
    heartbeatMs: 10_000,
  });
  rtm.onEvent((e) => events.push(e));
  return { rtm, sockets, events };
}

describe('SlackRtm', () => {
  test('opens the rtm.connect URL with the cookie and waits for hello', async () => {
    const { rtm, sockets } = harness();
    const connecting = rtm.connect('');
    const ws = await waitFor(() => sockets[0]);
    assert.equal(ws.url, RTM_URL);
    assert.equal(ws.headers.Cookie, `d=${COOKIE}`);
    assert.equal(rtm.state, 'connected');
    ws.serve({ type: 'hello' });
    await connecting;
    assert.equal(rtm.state, 'authenticated');
    rtm.close();
  });

  test('an error frame before hello fails the connection', async () => {
    const { rtm, sockets } = harness();
    const connecting = rtm.connect('');
    (await waitFor(() => sockets[0])).serve({ type: 'error', error: { code: 1, msg: 'too_many_connections' } });
    await assert.rejects(connecting, /too_many_connections/);
    assert.equal(rtm.state, 'closed');
  });

  test('a wrong team on rtm.connect is refused before any socket opens', async () => {
    const { rtm, sockets } = harness({ ok: true, team: { id: 'TXXX' }, self: { id: 'U000' }, url: RTM_URL });
    await assert.rejects(rtm.connect(''), /identity_mismatch/);
    assert.equal(sockets.length, 0);
  });

  test('a non-Slack socket URL is refused', async () => {
    const { rtm, sockets } = harness({ ok: true, team: { id: 'T000' }, self: { id: 'U000' }, url: 'wss://evil.example/ws' });
    await assert.rejects(rtm.connect(''), /invalid_rtm_url/);
    assert.equal(sockets.length, 0);
  });

  test('frames after hello reach the expander', async () => {
    const { rtm, sockets, events } = harness();
    const connecting = rtm.connect('');
    (await waitFor(() => sockets[0])).serve({ type: 'hello' });
    await connecting;
    sockets[0]!.serve({ type: 'message', channel: 'C1', ts: '1.000001' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventKey, 'C1');
    rtm.close();
  });

  test('a ping is answered by its pong; checkAlive is true', async () => {
    const { rtm, sockets } = harness();
    const connecting = rtm.connect('');
    const ws = await waitFor(() => sockets[0]);
    ws.serve({ type: 'hello' });
    await connecting;
    const alive = rtm.checkAlive();
    const ping = await waitFor(() => ws.sent.find((f) => f.type === 'ping'));
    ws.serve({ type: 'pong', reply_to: ping!.id });
    assert.equal(await alive, true);
    rtm.close();
  });

  test('two unanswered pings drop the socket and signal loss', async () => {
    const { rtm, sockets } = harness();
    let lost = 0;
    rtm.onLoss(() => (lost += 1));
    const connecting = rtm.connect('');
    (await waitFor(() => sockets[0])).serve({ type: 'hello' });
    await connecting;
    assert.equal(await rtm.checkAlive(), true); // first miss: still alive
    assert.equal(await rtm.checkAlive(), false); // second miss: dropped
    assert.equal(rtm.state, 'closed');
    assert.equal(lost, 1);
  });

  test('close before hello aborts without a loss callback', async () => {
    const { rtm, sockets } = harness();
    const connecting = rtm.connect('');
    const ws = await waitFor(() => sockets[0]);
    let lost = 0;
    rtm.onLoss(() => (lost += 1));
    rtm.close();
    await assert.rejects(connecting);
    assert.equal(ws.closed, true);
    assert.equal(lost, 0);
  });

  test('a typing frame goes out once per interval, cleared on stop', async () => {
    const { rtm, sockets } = harness();
    const connecting = rtm.connect('');
    const ws = await waitFor(() => sockets[0]);
    ws.serve({ type: 'hello' });
    await connecting;
    rtm.sendTyping('C1');
    rtm.sendTyping('C1');
    assert.equal(ws.sent.filter((f) => f.type === 'typing').length, 1);
    rtm.stopTyping('C1');
    rtm.sendTyping('C1');
    assert.equal(ws.sent.filter((f) => f.type === 'typing').length, 2);
    rtm.close();
  });
});
