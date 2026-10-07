import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { VoiceSnapshot } from '../modules/voice/index.ts';
import type { VoiceKey } from '../providers/rocketvibe/cryptoGroups.ts';
import type { VoiceGrant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import { DIRECT_GRACE_MS, SAVE_DELAY_MS, VoiceController, readListening, type ListeningStore, type VoiceEngine, type VoiceServer } from './voice.ts';

const user = (id: string) => ({ id, username: id, display_name: id });
const ring = (state: VoiceRing['state']): VoiceRing => ({ id: 'g1', room_id: 'dm', caller: user('me'), callee: user('bob'), state, expires_in_ms: 30000 });
const grant = (room: string, extra: Partial<VoiceGrant> = {}): VoiceGrant => ({
  room_id: room, url: 'wss://voice.test', token: 't', expires_at: '', can_publish: true, ...extra,
});

function bench(server: Partial<VoiceServer> = {}, consent = true, key: () => VoiceKey | null = () => null, store: ListeningStore | null = null) {
  const calls: string[] = [];
  let listener: (s: VoiceSnapshot) => void = () => {};
  let current: VoiceSnapshot = { state: 'idle', participants: [] };
  const emit = (s: VoiceSnapshot) => { current = s; listener(s); };
  const engine: VoiceEngine = {
    snapshot: () => current,
    connect: async o => {
      calls.push(`connect ${o.room} mic=${o.microphone}${o.e2eeKey ? ` key=${o.e2eeKey}` : ''}`);
      emit({ state: 'connecting', room: o.room, participants: [] });
    },
    setE2eeKey: async k => { calls.push(`rekey ${k}`); },
    disconnect: async () => { calls.push('disconnect'); emit({ state: 'disconnected', reason: 'client_initiated', participants: [] }); },
    setMicrophone: async on => { calls.push(`mic ${on}`); },
    setDeafened: async on => { calls.push(`deaf ${on}`); },
    setRoute: async () => {},
    setCamera: async on => { calls.push(`camera ${on}`); },
    startScreenShare: async () => { calls.push('screen'); return consent; },
    stopScreenShare: async () => { calls.push('stop screen'); },
    ringback: async on => { calls.push(`ringback ${on}`); },
    missed: async () => { calls.push('missed'); },
    setPersonVolume: async (uid, v, muted) => { calls.push(`volume ${uid} ${v}${muted ? ' muted' : ''}`); },
    setInputVolume: async v => { calls.push(`input ${v}`); },
    setOutputVolume: async v => { calls.push(`output ${v}`); },
    setNoiseSuppression: async on => { calls.push(`noise ${on}`); },
    setShareQuality: async (h, fps) => { calls.push(`quality ${h} ${fps}`); },
    addListener: (_e, fn) => { listener = fn; return { remove: () => {} }; },
  };
  const voice = new VoiceController(engine, {
    joinVoice: async (room, ring, e2ee) => { calls.push(`join ${room} ring=${ring}${e2ee ? ' e2ee' : ''}`); return grant(room, e2ee ? { e2ee } : {}); },
    leaveVoice: async () => { calls.push('leave'); },
    acceptRing: async (id, e2ee) => { calls.push(`accept ${id}${e2ee ? ' e2ee' : ''}`); return grant('dm', e2ee ? { e2ee } : {}); },
    voiceKey: async () => key(),
    declineRing: async id => { calls.push(`decline ${id}`); },
    claimScreen: async () => { calls.push('claim'); },
    releaseScreen: async () => { calls.push('release'); },
    ...server,
  }, store);
  return { voice, calls, emit };
}

const member = (identity: string, local = false) => ({ identity, speaking: false, muted: false, deafened: false, level: 0, local });

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
    setCamera: async () => {}, startScreenShare: async () => true, stopScreenShare: async () => {}, setE2eeKey: async () => {},
    setPersonVolume: async () => {}, setInputVolume: async () => {}, setOutputVolume: async () => {},
    setNoiseSuppression: async () => {}, setShareQuality: async () => {},
    addListener: () => ({ remove: () => {} }),
  };
  const voice = new VoiceController(engine, { joinVoice: async r => grant(r), leaveVoice: async () => {}, acceptRing: async () => grant('dm'), declineRing: async () => {}, claimScreen: async () => {}, releaseScreen: async () => {}, voiceKey: async () => null });
  assert.deepEqual([voice.state.phase, voice.state.room, voice.state.microphone, voice.state.deafened], ['connected', 'lounge', false, true]);
});

test('the screen is claimed from the server before Android is asked, and given back when refused or stopped', async () => {
  const shared = bench();
  await shared.voice.join('lounge', { title: 'Lounge', microphone: true });
  shared.calls.length = 0;
  assert.equal(await shared.voice.shareScreen(), true);
  assert.deepEqual(shared.calls, ['claim', 'screen']);
  shared.emit({ state: 'connected', room: 'lounge', sharing: true, participants: [] });
  // Stopped from the system's projection notification.
  shared.emit({ state: 'connected', room: 'lounge', sharing: false, participants: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(shared.calls.includes('release'));

  const refused = bench({}, false);
  await refused.voice.join('lounge', { title: 'Lounge', microphone: true });
  refused.calls.length = 0;
  assert.equal(await refused.voice.shareScreen(), false);
  assert.deepEqual(refused.calls, ['claim', 'screen', 'release']);

  const taken = bench({ claimScreen: async () => { throw new Error('screen_taken'); } });
  await taken.voice.join('lounge', { title: 'Lounge', microphone: true });
  await assert.rejects(taken.voice.shareScreen(), /screen_taken/);
  assert.ok(!taken.calls.includes('screen'));
});

test('an encrypted room connects with its group key, follows new epochs, and never connects in clear', async () => {
  let current: VoiceKey | null = { epoch: '3', key: 'k3' };
  const secure = bench({}, true, () => current);
  await secure.voice.join('vault', { title: 'Vault', microphone: true });
  assert.deepEqual(secure.calls, ['join vault ring=false e2ee', 'connect vault mic=true key=k3']);
  await secure.voice.refreshKey();
  assert.ok(!secure.calls.some(c => c.startsWith('rekey')), 'same epoch, same key');
  current = { epoch: '4', key: 'k4' };
  await secure.voice.refreshKey();
  current = null; // Briefly unreadable: the last key stays.
  await secure.voice.refreshKey();
  assert.deepEqual(secure.calls.filter(c => c.startsWith('rekey')), ['rekey k4']);
  await secure.voice.leave();
  current = { epoch: '5', key: 'k5' };
  await secure.voice.refreshKey();
  assert.ok(!secure.calls.includes('rekey k5'), 'nothing to follow once left');

  // The room turned encrypted after the key was asked for: no plaintext connection.
  const late = bench({ joinVoice: async room => grant(room, { e2ee: true }) });
  await assert.rejects(late.voice.join('vault', { title: 'Vault', microphone: true }), /voice_key_unavailable/);
  assert.ok(!late.calls.some(c => c.startsWith('connect')));
  assert.equal(late.voice.state.phase, 'idle');

  // A device without the key yet is told so before asking the server.
  const behind = bench({ voiceKey: async () => { throw new Error('voice_key_unavailable'); } });
  await assert.rejects(behind.voice.join('vault', { title: 'Vault', microphone: true }), /voice_key_unavailable/);
  assert.deepEqual(behind.calls, []);
});

test('a direct call hangs up once the other person left, after a grace', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { voice, calls, emit } = bench();
    await voice.join('dm', { title: 'Bob', microphone: true, direct: true });
    // Alone before they answer: nothing to end.
    emit({ state: 'connected', room: 'dm', participants: [member('me', true)] });
    mock.timers.tick(DIRECT_GRACE_MS * 2);
    assert.equal(voice.state.phase, 'connected');
    emit({ state: 'connected', room: 'dm', participants: [member('me', true), member('bob')] });
    // A blip shorter than the grace keeps the call.
    emit({ state: 'connected', room: 'dm', participants: [member('me', true)] });
    emit({ state: 'connected', room: 'dm', participants: [member('me', true), member('bob')] });
    mock.timers.tick(DIRECT_GRACE_MS * 2);
    assert.equal(voice.state.phase, 'connected');
    emit({ state: 'connected', room: 'dm', participants: [member('me', true)] });
    mock.timers.tick(DIRECT_GRACE_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(voice.state.phase, 'idle');
    assert.equal(voice.state.direct, true, 'the screen knows to give the chat back');
    assert.ok(calls.includes('disconnect') && calls.includes('leave'));
  } finally {
    mock.timers.reset();
  }
});

test('a channel stays joined when everyone else leaves', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { voice, emit } = bench();
    await voice.join('lounge', { title: 'Lounge', microphone: true });
    emit({ state: 'connected', room: 'lounge', participants: [member('me', true), member('bob')] });
    emit({ state: 'connected', room: 'lounge', participants: [member('me', true)] });
    mock.timers.tick(DIRECT_GRACE_MS * 2);
    assert.equal(voice.state.phase, 'connected');
    assert.equal(voice.state.direct, false);
  } finally {
    mock.timers.reset();
  }
});

test('listening choices come back from the store, reach the engine and are kept', async () => {
  let saved: string | null = JSON.stringify({ people: { bob: { volume: 5, muted: true } }, inputVolume: 1.5, share: { height: 1440, fps: 60 } });
  const store: ListeningStore = { load: async () => saved, save: async json => { saved = json; } };
  const { voice, calls } = bench({}, true, () => null, store);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['volume bob 2 muted', 'input 1.5', 'output 1', 'noise true', 'quality 1440 60']);
  assert.equal(voice.listening.people.bob?.volume, 2, 'clamped to 200 %');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await voice.setPersonVolume('alice', 0.5, false);
    await voice.setNoiseSuppression(false);
    await voice.setShareQuality(999, 30);
    assert.equal(readListening(saved).people.alice, undefined, 'written once the changes rest');
    mock.timers.tick(SAVE_DELAY_MS);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(readListening(saved).people.alice, { volume: 0.5, muted: false });
  assert.equal(readListening(saved).noiseSuppression, false);
  assert.deepEqual(readListening(saved).share, { height: 1080, fps: 30 }, 'an unknown height falls back');
  assert.deepEqual(readListening('not json'), readListening(null));
});
