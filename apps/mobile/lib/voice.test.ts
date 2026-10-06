import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { VoiceSnapshot } from '../modules/voice/index.ts';
import type { VoiceGrant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import { VoiceController, type VoiceEngine, type VoiceServer } from './voice.ts';

const user = (id: string) => ({ id, username: id, display_name: id });
const ring = (state: VoiceRing['state']): VoiceRing => ({ id: 'g1', room_id: 'dm', caller: user('me'), callee: user('bob'), state, expires_in_ms: 30000 });
const grant = (room: string, extra: Partial<VoiceGrant> = {}): VoiceGrant => ({
  room_id: room, url: 'wss://voice.test', token: 't', expires_at: '', can_publish: true, ...extra,
});

function bench(server: Partial<VoiceServer> = {}) {
  const calls: string[] = [];
  let listener: (s: VoiceSnapshot) => void = () => {};
  let current: VoiceSnapshot = { state: 'idle', participants: [] };
  const emit = (s: VoiceSnapshot) => { current = s; listener(s); };
  const engine: VoiceEngine = {
    snapshot: () => current,
    connect: async o => { calls.push(`connect ${o.room} mic=${o.microphone}`); emit({ state: 'connecting', room: o.room, participants: [] }); },
    disconnect: async () => { calls.push('disconnect'); emit({ state: 'disconnected', reason: 'client_initiated', participants: [] }); },
    setMicrophone: async on => { calls.push(`mic ${on}`); },
    setDeafened: async on => { calls.push(`deaf ${on}`); },
    setRoute: async () => {},
    ringback: async on => { calls.push(`ringback ${on}`); },
    missed: async () => { calls.push('missed'); },
    addListener: (_e, fn) => { listener = fn; return { remove: () => {} }; },
  };
  const voice = new VoiceController(engine, {
    joinVoice: async (room, ring) => { calls.push(`join ${room} ring=${ring}`); return grant(room); },
    leaveVoice: async () => { calls.push('leave'); },
    acceptRing: async id => { calls.push(`accept ${id}`); return grant('dm'); },
    declineRing: async id => { calls.push(`decline ${id}`); },
    ...server,
  });
  return { voice, calls, emit };
}

test('joining asks the server, then connects the engine; leaving ends both', async () => {
  const { voice, calls, emit } = bench();
  await voice.join('lounge', { title: 'Lounge', microphone: true });
  assert.equal(voice.state.phase, 'connecting');
  emit({ state: 'connected', room: 'lounge', microphone: true, participants: [{ identity: 'me', speaking: false, muted: false, deafened: false, level: 0, local: true }] });
  assert.equal(voice.state.phase, 'connected');
  assert.equal(voice.state.room, 'lounge');
  await voice.leave();
  assert.equal(voice.state.phase, 'idle');
  assert.deepEqual(calls, ['join lounge ring=false', 'connect lounge mic=true', 'ringback false', 'disconnect', 'leave']);
});

test('a listener without publishing rights joins with its microphone off', async () => {
  const { voice, calls } = bench({ joinVoice: async room => grant(room, { can_publish: false }) });
  await voice.join('stage', { title: 'Stage', microphone: true });
  assert.deepEqual(calls, ['connect stage mic=false']);
});

test('a refused join restores the previous state and surfaces the refusal', async () => {
  const { voice } = bench({ joinVoice: async () => { throw new Error('voice_encrypted_room'); } });
  await assert.rejects(voice.join('secret', { title: 'Secret', microphone: true }), /voice_encrypted_room/);
  assert.equal(voice.state.phase, 'idle');
});

test('the SFU closing the session says why, and never tells the server to leave', async () => {
  const { voice, calls, emit } = bench();
  await voice.join('lounge', { title: 'Lounge', microphone: true });
  emit({ state: 'disconnected', reason: 'duplicate_identity', participants: [] });
  assert.equal(voice.state.ended, 'moved');
  assert.ok(!calls.includes('leave'), 'another device holds the session now');
  await voice.join('lounge', { title: 'Lounge', microphone: true });
  emit({ state: 'disconnected', reason: 'participant_removed', participants: [] });
  assert.equal(voice.state.ended, 'removed');
});

test('a leave from the notification while JS listens tells the server', async () => {
  const { voice, calls, emit } = bench();
  await voice.join('lounge', { title: 'Lounge', microphone: true });
  emit({ state: 'disconnected', reason: 'client_initiated', participants: [] });
  assert.equal(voice.state.phase, 'idle');
  assert.equal(voice.state.ended, null);
  assert.ok(calls.includes('leave'));
});

test('a direct call rings back until answered, and hangs up when declined', async () => {
  const { voice, calls, emit } = bench({ joinVoice: async () => grant('dm', { ring: ring('ringing') }) });
  await voice.join('dm', { title: 'Bob', ring: true, microphone: true });
  assert.ok(calls.includes('ringback true'));
  voice.observeRings([ring('declined')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('missed'));
  assert.ok(calls.includes('disconnect'));
  assert.equal(voice.state.phase, 'idle');

  calls.length = 0;
  await voice.join('dm', { title: 'Bob', ring: true, microphone: true });
  // The callee arrives on the SFU: the ringback stops before the live snapshot says so.
  emit({ state: 'connected', room: 'dm', participants: [
    { identity: 'me', speaking: false, muted: false, deafened: false, level: 0, local: true },
    { identity: 'bob', speaking: true, muted: false, deafened: false, level: 0.4, local: false },
  ] });
  assert.equal(calls.filter(c => c === 'ringback false').length, 1);
});

test('an engine that kept the call across a JS reload is adopted', () => {
  const engine: VoiceEngine = {
    snapshot: () => ({ state: 'connected', room: 'lounge', microphone: false, deafened: true, participants: [] }),
    connect: async () => {}, disconnect: async () => {}, setMicrophone: async () => {}, setDeafened: async () => {},
    setRoute: async () => {}, ringback: async () => {}, missed: async () => {},
    addListener: () => ({ remove: () => {} }),
  };
  const voice = new VoiceController(engine, { joinVoice: async r => grant(r), leaveVoice: async () => {}, acceptRing: async () => grant('dm'), declineRing: async () => {} });
  assert.deepEqual([voice.state.phase, voice.state.room, voice.state.microphone, voice.state.deafened], ['connected', 'lounge', false, true]);
});
