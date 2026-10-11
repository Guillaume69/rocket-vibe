import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conferenceCheck, declineConference, setProviderCalls } from './call.ts';
import { CallRinger, RING_CHECK_MS, RING_MS, callSignalOfMessage, type CallCheck, type CallSignal, type RingerDeps } from './callRing.ts';
import type { LocalMessage } from './normalize.ts';
import { RestClient } from './rest.ts';
import { kmeetCall } from '../providers/mattermost/translator.ts';

const NOW = 1_800_000_000_000;

function bench(overrides: Partial<RingerDeps> = {}) {
  let now = NOW;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  let check: CallCheck | null | Error = null;
  let checks = 0;
  const ringer = new CallRinger({
    me: 'me',
    now: () => now,
    directPeer: async rid => rid === 'dm' ? { uid: 'bob', name: 'Bob' } : null,
    check: async () => { checks++; if (check instanceof Error) throw check; return check; },
    schedule: (run, ms) => { const timer = { at: now + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    ...overrides,
  });
  return {
    ringer,
    setCheck: (value: CallCheck | null | Error) => { check = value; },
    checks: () => checks,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers.filter(t => t.live && t.at <= now)) { timer.live = false; timer.run(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const call = (over: Partial<Extract<CallSignal, { kind: 'call' }>> = {}): CallSignal =>
  ({ kind: 'call', rid: 'dm', messageId: 'm1', callId: 'c1', authorId: 'bob', ts: NOW - 1000, ...over });

test('a fresh call from the other member of a direct room rings once, then stops after RING_MS', async () => {
  const b = bench();
  await b.ringer.signal(call());
  assert.deepEqual(b.ringer.ringing, { messageId: 'm1', rid: 'dm', callId: 'c1', callerId: 'bob', callerName: 'Bob', until: NOW - 1000 + RING_MS });
  b.ringer.stop();
  await b.ringer.signal(call());
  assert.equal(b.ringer.ringing, null);
  const c = bench();
  await c.ringer.signal(call());
  await c.advance(RING_MS - 1000);
  assert.equal(c.ringer.ringing, null);
});

test('no ring for my own call, an old one, a group room or a busy line', async () => {
  for (const signal of [call({ authorId: 'me' }), call({ ts: NOW - RING_MS - 1 }), call({ rid: 'group' })]) {
    const b = bench();
    await b.ringer.signal(signal);
    assert.equal(b.ringer.ringing, null);
  }
  const b = bench();
  await b.ringer.signal(call());
  await b.ringer.signal(call({ messageId: 'm2', callId: 'c2' }));
  assert.equal(b.ringer.ringing?.callId, 'c1');
});

test('the server record decides the caller: a call message posted by the provider app or a forged one', async () => {
  const b = bench();
  b.setCheck({ rid: 'dm', callerId: 'bob', callerName: 'Bob Durand', over: false, joined: [] });
  await b.ringer.signal(call({ authorId: 'jitsi.bot' }));
  assert.equal(b.ringer.ringing?.callerName, 'Bob Durand');
  for (const record of [
    { rid: 'dm', callerId: 'me', callerName: null, over: false, joined: [] },
    { rid: 'elsewhere', callerId: 'bob', callerName: null, over: false, joined: [] },
    { rid: 'dm', callerId: 'bob', callerName: null, over: true, joined: [] },
    { rid: 'dm', callerId: 'bob', callerName: null, over: false, joined: ['me'] },
    new Error('invalid-params'),
  ]) {
    const other = bench();
    other.setCheck(record);
    await other.ringer.signal(call());
    assert.equal(other.ringer.ringing, null);
  }
});

test('the ring follows the server record: over or answered on another device stops it', async () => {
  const b = bench();
  b.setCheck({ rid: 'dm', callerId: 'bob', callerName: null, over: false, joined: [] });
  await b.ringer.signal(call());
  await b.advance(RING_CHECK_MS);
  assert.notEqual(b.ringer.ringing, null);
  b.setCheck({ rid: 'dm', callerId: 'bob', callerName: null, over: false, joined: ['bob', 'me'] });
  await b.advance(RING_CHECK_MS);
  assert.equal(b.ringer.ringing, null);
  assert.equal(b.checks(), 3);
});

test("kChat's post edited to ended stops the ring, and an ended call never rings late", async () => {
  const b = bench();
  await b.ringer.signal(call());
  await b.ringer.signal({ kind: 'over', messageId: 'm1' });
  assert.equal(b.ringer.ringing, null);
  const late = bench();
  let release: () => void = () => {};
  const slow = bench({ directPeer: () => new Promise(resolve => { release = () => resolve({ uid: 'bob', name: null }); }) });
  const pending = slow.ringer.signal(call());
  await slow.ringer.signal({ kind: 'over', messageId: 'm1' });
  release();
  await pending;
  assert.equal(slow.ringer.ringing, null);
  await late.ringer.signal({ kind: 'over', messageId: 'm1' });
  await late.ringer.signal(call());
  assert.equal(late.ringer.ringing, null);
});

test('signals from messages: a running call rings, an ended kMeet call is over', () => {
  const base = { id: 'm1', rid: 'dm', authorId: 'bob', ts: NOW, callId: 'c1', systemType: 'videoconf' } as LocalMessage;
  assert.deepEqual(callSignalOfMessage(base), { kind: 'call', rid: 'dm', messageId: 'm1', callId: 'c1', authorId: 'bob', ts: NOW });
  assert.deepEqual(callSignalOfMessage({ ...base, systemType: 'videoconf-ended', callId: null }), { kind: 'over', messageId: 'm1' });
  assert.equal(callSignalOfMessage({ ...base, systemType: null }), null);
  assert.equal(kmeetCall({ status: 'calling', conference_id: 'k1' }).type, 'videoconf');
  assert.equal(kmeetCall({ status: 'missed', conference_id: 'k1' }).type, 'videoconf-ended');
});

test("Rocket.Chat's record comes from video-conference.info and a decline is video-conference.cancel", async () => {
  const requests: string[] = [];
  const client = new RestClient('https://chat.example.test', { fetch: async (url, options) => {
    const path = String(url).split('/api/v1/')[1];
    requests.push(`${options!.method} ${path} ${options!.body ?? ''}`);
    return path.startsWith('video-conference.info')
      ? Response.json({ success: true, rid: 'dm', status: 1, createdBy: { _id: 'bob', username: 'bob', name: 'Bob' }, users: [{ _id: 'bob' }] })
      : Response.json({ success: true });
  } });
  const detach = setProviderCalls(client, null);
  try {
    assert.deepEqual(await conferenceCheck(client, 'c1'), { rid: 'dm', callerId: 'bob', callerName: 'Bob', over: false, joined: ['bob'] });
    await declineConference(client, 'c1');
    assert.deepEqual(requests, ['GET video-conference.info?callId=c1 ', 'POST video-conference.cancel {"callId":"c1"}']);
  } finally { detach(); }
});

test("kChat's post is the record and its decline is the conference's", async () => {
  const client = new RestClient('https://team.kchat.example.test', { fetch: async () => { throw new Error('no Rocket.Chat request'); } });
  const declined: string[] = [];
  const detach = setProviderCalls(client, { available: async () => true, memo: () => true, start: async () => 'k1', join: async () => 'https://kmeet.infomaniak.com/x', decline: async id => { declined.push(id); } });
  try {
    assert.equal(await conferenceCheck(client, 'k1'), null);
    await declineConference(client, 'k1');
    assert.deepEqual(declined, ['k1']);
  } finally { detach(); }
});

test("Rocket.Chat signals a call from a room's new lastMessage and from the open room's stream", async () => {
  const { createRcProvider } = await import('../providers/rocketchat/index.ts');
  const session = { baseUrl: 'https://chat.example.test', userId: 'me', username: 'me', authToken: 't' } as Parameters<typeof createRcProvider>[0];
  const provider = createRcProvider(session, new RestClient(session.baseUrl, { fetch: async () => Response.json({}) }), () => 'id');
  const message = { _id: 'm1', rid: 'dm', t: 'videoconf', msg: '', ts: { $date: NOW }, u: { _id: 'bob', username: 'bob' }, blocks: [{ type: 'video_conf', callId: 'c1' }], _updatedAt: { $date: NOW } };
  const expected = { kind: 'call', rid: 'dm', messageId: 'm1', callId: 'c1', authorId: 'bob', ts: NOW };
  assert.deepEqual(provider.callSignal!({ collection: 'stream-notify-user', eventKey: 'me/rooms-changed', args: ['updated', { _id: 'dm', t: 'd', lastMessage: message }] }), expected);
  assert.deepEqual(provider.callSignal!({ collection: 'stream-room-messages', eventKey: 'dm', args: [message] }), expected);
  assert.equal(provider.callSignal!({ collection: 'stream-notify-user', eventKey: 'me/rooms-changed', args: ['updated', { _id: 'dm', t: 'd', lastMessage: { ...message, t: undefined } }] }), null);
  provider.listener.close();
});
