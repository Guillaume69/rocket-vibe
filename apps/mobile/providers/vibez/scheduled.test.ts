import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { nativeScheduled, type ScheduledGate } from './scheduled.ts';
import { effectiveCapabilities, ROCKETVIBE_CAPABILITIES } from './index.ts';
import type { NativeTypes } from './protocol.generated.ts';

const pending: NativeTypes['ScheduledMessage'] = { id: 's-1', room_id: 'room id', text: 'see you', send_at: '2026-10-12T08:00:00Z', state: 'pending' };

test('scheduled routes, verbs and bodies follow SCHEDULED.md', async () => {
  const sent: { verb: string | undefined; url: string; body: string | undefined }[] = [];
  const client = new NativeTransport('https://example.org/chat', async (url, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer saved-token');
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace('/chat', '');
    sent.push({ verb: options?.method, url: path, body: options?.body as string | undefined });
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (options?.method === 'GET') return Response.json({ messages: [pending, { ...pending, id: 's-2', state: 'failed', error: 'forbidden' }] });
    return Response.json({ ...pending, reply_to: 'root' });
  });
  client.restore('saved-token');
  const input = { operation_id: 'op-1', text: 'see you', reply_to: 'root', send_at: '2026-10-12T08:00:00.000Z' };
  assert.equal((await client.scheduleMessage('room id', input)).reply_to, 'root');
  assert.equal((await client.scheduledMessages()).messages[1].error, 'forbidden');
  await client.cancelScheduled('s 1');
  assert.deepEqual(sent.map((r) => [r.verb, r.url]), [
    ['POST', '/api/v1/rooms/room%20id/scheduled'], ['GET', '/api/v1/scheduled'], ['DELETE', '/api/v1/scheduled/s%201'],
  ]);
  assert.deepEqual(JSON.parse(sent[0].body!), input);
  assert.equal(sent[1].body, undefined);
  // A body outside the contract is refused, not shown.
  const broken = new NativeTransport('https://example.org', async () => Response.json({ messages: [{ ...pending, state: 'sent' }] }));
  broken.restore('t');
  await assert.rejects(broken.scheduledMessages());
});

function harness(answers: ((input: NativeTypes['ScheduleMessage']) => NativeTypes['ScheduledMessage'])[], list: NativeTypes['ScheduledMessage'][] = []) {
  const bodies: NativeTypes['ScheduleMessage'][] = [];
  const cancelled: string[] = [];
  let next = 0;
  const transport = {
    scheduleMessage: async (room: string, input: NativeTypes['ScheduleMessage']) => {
      bodies.push(input);
      const answer = answers.shift();
      if (!answer) throw new Error('unexpected schedule');
      return { ...answer(input), room_id: room };
    },
    scheduledMessages: async () => ({ messages: list }),
    cancelScheduled: async (id: string) => { cancelled.push(id); },
  };
  const gate: ScheduledGate = (call) => call(transport, () => `op-${++next}`);
  return { scheduled: nativeScheduled(gate), bodies, cancelled };
}
const lost = () => { throw new NativeError(0, 'network_or_protocol_error'); };
const made = (input: NativeTypes['ScheduleMessage']): NativeTypes['ScheduledMessage'] => ({ id: `made-${input.operation_id}`, room_id: '', text: input.text, send_at: input.send_at, state: 'pending', ...(input.reply_to ? { reply_to: input.reply_to } : {}) });

test('a retry replays the operation until the server answers, then a new one starts', async () => {
  const at = Date.parse('2026-10-12T08:00:00Z');
  const { scheduled, bodies } = harness([lost, made, made]);
  await assert.rejects(scheduled.schedule('room', 'hello', at, 'root'), /network/);
  const item = await scheduled.schedule('room', 'hello', at, 'root');
  assert.deepEqual(bodies.map((b) => b.operation_id), ['op-1', 'op-1'], 'the lost answer is replayed under the same id');
  assert.deepEqual(item, { id: 'made-op-1', rid: 'room', text: 'hello', threadId: 'root', sendAt: at, failed: false, error: null });
  assert.equal(bodies[0].send_at, '2026-10-12T08:00:00.000Z');
  assert.equal(bodies[0].reply_to, 'root');
  await scheduled.schedule('room', 'hello', at, 'root');
  assert.equal(bodies[2].operation_id, 'op-2', 'an answered operation is never reused');
});

test('a refusal settles the operation; a different text or room is another operation', async () => {
  const refused = () => { throw new NativeError(400, 'invalid_request'); };
  const busy = () => { throw new NativeError(429, 'rate_limited'); };
  const { scheduled, bodies } = harness([refused, made, busy, made, made]);
  await assert.rejects(scheduled.schedule('room', 'hello', 0, null), /invalid_request/);
  await scheduled.schedule('room', 'hello', 0, null);
  await assert.rejects(scheduled.schedule('room', 'other', 0, null), /rate_limited/);
  await scheduled.schedule('room', 'other', 0, null);
  await scheduled.schedule('elsewhere', 'other', 0, null);
  assert.deepEqual(bodies.map((b) => b.operation_id), ['op-1', 'op-2', 'op-3', 'op-3', 'op-4']);
  assert.equal('reply_to' in bodies[0], false, 'a room message carries no reply_to');
});

test('the list keeps this room, soonest first, and says why a failed one failed', async () => {
  const { scheduled, cancelled } = harness([], [
    { ...pending, id: 'late', room_id: 'room', send_at: '2026-10-13T08:00:00Z' },
    { ...pending, id: 'other', room_id: 'other' },
    { ...pending, id: 'failed', room_id: 'room', send_at: '2026-10-11T08:00:00Z', state: 'failed', error: 'encrypted_room' },
  ]);
  const items = await scheduled.list('room');
  assert.deepEqual(items.map((i) => [i.id, i.failed, i.error]), [['failed', true, 'encrypted_room'], ['late', false, null]]);
  await scheduled.cancel('late');
  assert.deepEqual(cancelled, ['late']);
});

test('the app offers scheduling only when the server announces it', () => {
  assert.equal(effectiveCapabilities({ scheduled_messages: true } as NativeTypes['Capabilities']).scheduledMessages, true);
  assert.equal(effectiveCapabilities({} as NativeTypes['Capabilities']).scheduledMessages, false);
  assert.equal(effectiveCapabilities({ scheduled_messages: true } as NativeTypes['Capabilities'], { ...ROCKETVIBE_CAPABILITIES, scheduledMessages: false }).scheduledMessages, false);
});
