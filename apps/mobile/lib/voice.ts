/**
 * Voice sessions on a RocketVibe server (docs/protocol/VOICE.md): the server
 * grants, the native engine (modules/voice) speaks WebRTC to LiveKit. One
 * connection per account, so one controller per signed-in native chat.
 *
 * Node-pure: the engine and the server are injected, the tests drive both.
 */
import type { VoiceKey } from '../providers/rocketvibe/cryptoGroups.ts';
import type { VoiceGrant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import type { VoiceMember, VoiceRoute, VoiceSnapshot } from '../modules/voice/index.ts';

export type VoiceEngine = {
  snapshot(): VoiceSnapshot;
  connect(options: { room: string; url: string; token: string; title: string; link?: string | null; microphone: boolean; e2eeKey?: string | null }): Promise<void>;
  disconnect(): Promise<void>;
  setE2eeKey(key: string): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  setDeafened(on: boolean): Promise<void>;
  setRoute(route: VoiceRoute): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  startScreenShare(): Promise<boolean>;
  stopScreenShare(): Promise<void>;
  ringback(on: boolean): Promise<void>;
  missed(): Promise<void>;
  setPersonVolume(identity: string, volume: number, muted: boolean): Promise<void>;
  setInputVolume(volume: number): Promise<void>;
  setOutputVolume(volume: number): Promise<void>;
  setNoiseSuppression(on: boolean): Promise<void>;
  setShareQuality(height: number, fps: number): Promise<void>;
  addListener(event: 'change', listener: (snapshot: VoiceSnapshot) => void): { remove: () => void };
};

/**
 * How this side hears the call and shares its screen, kept between runs: each
 * person's volume (0 to 2, 1 as sent) and a mute for this side only, the
 * microphone's and the speakers' volumes, the noise remover, a share's lines
 * and frames a second.
 */
export type Listening = {
  people: Record<string, { volume: number; muted: boolean }>;
  inputVolume: number;
  outputVolume: number;
  noiseSuppression: boolean;
  share: { height: number; fps: number };
};
export const DEFAULT_LISTENING: Listening = {
  people: {}, inputVolume: 1, outputVolume: 1, noiseSuppression: true, share: { height: 1080, fps: 15 },
};
/** Where the listening choices are kept (SecureStore in the app). */
export type ListeningStore = { load(): Promise<string | null>; save(json: string): Promise<void> };

const volume = (v: unknown, fallback = 1): number => typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : fallback;

/** A stored value, whatever its age or damage, as valid choices. */
export function readListening(raw: string | null): Listening {
  let value: Partial<Listening> & Record<string, unknown> = {};
  try { value = raw ? JSON.parse(raw) as typeof value : {}; } catch { value = {}; }
  const people: Listening['people'] = {};
  for (const [uid, p] of Object.entries(value.people ?? {})) {
    if (p && typeof p === 'object') people[uid] = { volume: volume(p.volume), muted: p.muted === true };
  }
  const share = value.share && typeof value.share === 'object' ? value.share : DEFAULT_LISTENING.share;
  return {
    people,
    inputVolume: volume(value.inputVolume),
    outputVolume: volume(value.outputVolume),
    noiseSuppression: value.noiseSuppression !== false,
    share: {
      height: [720, 1080, 1440].includes(share.height) ? share.height : 1080,
      fps: [15, 30, 60].includes(share.fps) ? share.fps : 15,
    },
  };
}

/** The other person of a direct call gone: hang up after this grace (a reconnection, a device switch). */
export const DIRECT_GRACE_MS = 2000;
/** Listening choices are written this long after the last change. */
export const SAVE_DELAY_MS = 400;
export type VoiceServer = {
  joinVoice(room: string, ring: boolean, e2ee: boolean): Promise<VoiceGrant>;
  leaveVoice(): Promise<void>;
  acceptRing(id: string, e2ee: boolean): Promise<VoiceGrant>;
  /**
   * An encrypted room's voice key from its MLS group, null in a plaintext
   * room; throws when this device cannot derive it (voice_key_unavailable).
   */
  voiceKey(room: string): Promise<VoiceKey | null>;
  declineRing(id: string): Promise<void>;
  /** The room's one screen share (`409 screen_taken` while someone else holds it). */
  claimScreen(): Promise<void>;
  releaseScreen(): Promise<void>;
};

/** What the screens read: the engine's view, plus the step before it (asking the server). */
export type VoiceView = {
  phase: 'idle' | 'joining' | 'connecting' | 'connected' | 'reconnecting';
  room: string | null;
  microphone: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  /** Frames are end-to-end encrypted (an encrypted room). */
  encrypted: boolean;
  participants: VoiceMember[];
  route: VoiceRoute | null;
  routes: VoiceRoute[];
  /** The direct call this session rings, until it resolves. */
  ring: VoiceRing | null;
  /** Why the last session ended when the user did not end it. */
  ended: 'moved' | 'removed' | 'lost' | null;
  /** A direct room's call: over, the chat comes back. */
  direct: boolean;
};

/** How often an encrypted session checks its group for a new epoch. */
const KEY_REFRESH_MS = 15_000;

const IDLE: VoiceView = {
  phase: 'idle', room: null, microphone: true, deafened: false, camera: false, sharing: false, encrypted: false, participants: [],
  route: null, routes: [], ring: null, ended: null, direct: false,
};

export type JoinOptions = {
  title: string; link?: string | null; ring?: boolean; microphone: boolean;
  /** A direct room: when the other person leaves, this side hangs up too. */
  direct?: boolean;
};

export class VoiceController {
  private view: VoiceView = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly subscription: { remove: () => void };
  /** Increments on every join or leave: a late answer of an older one is dropped. */
  private attempt = 0;
  private leaving = false;
  /** The encrypted session's room and key epoch, followed while it lasts. */
  private keyed: { room: string; epoch: string } | null = null;
  private keyTimer: ReturnType<typeof setInterval> | null = null;
  /** A direct call's room, whether the other person was in it, and the grace before hanging up. */
  private directRoom: string | null = null;
  private company = false;
  private alone: ReturnType<typeof setTimeout> | null = null;
  private listeningState: Listening = DEFAULT_LISTENING;

  private readonly engine: VoiceEngine;
  private readonly server: VoiceServer;
  private readonly store: ListeningStore | null;

  constructor(engine: VoiceEngine, server: VoiceServer, store: ListeningStore | null = null) {
    this.engine = engine;
    this.server = server;
    this.store = store;
    this.subscription = engine.addListener('change', s => this.adopt(s));
    // A JS reload finds the call the engine kept.
    this.adopt(engine.snapshot());
    if (store) void this.restore(store);
  }

  get listening(): Listening { return this.listeningState; }

  /** The choices of an earlier run, handed to the engine, which keeps them for the process. */
  private async restore(store: ListeningStore): Promise<void> {
    const kept = readListening(await store.load().catch(() => null));
    this.listeningState = kept;
    for (const [uid, p] of Object.entries(kept.people)) await this.engine.setPersonVolume(uid, p.volume, p.muted);
    await this.engine.setInputVolume(kept.inputVolume);
    await this.engine.setOutputVolume(kept.outputVolume);
    await this.engine.setNoiseSuppression(kept.noiseSuppression);
    await this.engine.setShareQuality(kept.share.height, kept.share.fps);
    this.notify();
  }

  /** A slider moves many times a second: the choices are written once it rests. */
  private saving: ReturnType<typeof setTimeout> | null = null;
  private listen(next: Partial<Listening>): void {
    this.listeningState = { ...this.listeningState, ...next };
    this.notify();
    const store = this.store;
    if (!store) return;
    if (this.saving !== null) clearTimeout(this.saving);
    this.saving = setTimeout(() => {
      this.saving = null;
      void store.save(JSON.stringify(this.listeningState)).catch(() => {});
    }, SAVE_DELAY_MS);
  }

  async setPersonVolume(uid: string, level: number, muted: boolean): Promise<void> {
    const person = { volume: volume(level), muted };
    this.listen({ people: { ...this.listeningState.people, [uid]: person } });
    await this.engine.setPersonVolume(uid, person.volume, muted);
  }
  async setInputVolume(level: number): Promise<void> {
    this.listen({ inputVolume: volume(level) });
    await this.engine.setInputVolume(volume(level));
  }
  async setOutputVolume(level: number): Promise<void> {
    this.listen({ outputVolume: volume(level) });
    await this.engine.setOutputVolume(volume(level));
  }
  async setNoiseSuppression(on: boolean): Promise<void> {
    this.listen({ noiseSuppression: on });
    await this.engine.setNoiseSuppression(on);
  }
  async setShareQuality(height: number, fps: number): Promise<void> {
    const share = readListening(JSON.stringify({ share: { height, fps } })).share;
    this.listen({ share });
    await this.engine.setShareQuality(share.height, share.fps);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get state(): VoiceView { return this.view; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void { this.subscription.remove(); this.listeners.clear(); this.unkey(); this.undirect(); }

  private set(next: Partial<VoiceView>): void {
    this.view = { ...this.view, ...next };
    this.notify();
  }

  private undirect(): void {
    if (this.alone !== null) clearTimeout(this.alone);
    this.alone = null;
    this.directRoom = null;
    this.company = false;
  }

  /** A direct call: the other person's leaving ends it here too, after a short grace. */
  private followDirect(s: VoiceSnapshot): void {
    if (this.directRoom === null || s.room !== this.directRoom || s.state !== 'connected') return;
    if (s.participants.some(p => !p.local)) {
      this.company = true;
      if (this.alone !== null) clearTimeout(this.alone);
      this.alone = null;
      return;
    }
    if (!this.company || this.alone !== null) return;
    const room = this.directRoom;
    this.alone = setTimeout(() => {
      this.alone = null;
      if (this.view.room === room && !this.view.participants.some(p => !p.local)) void this.leave();
    }, DIRECT_GRACE_MS);
  }

  private adopt(s: VoiceSnapshot): void {
    if (s.state === 'idle' || s.state === 'disconnected') {
      // Joining: the engine reports the previous room's end, not ours.
      if (this.view.phase === 'joining') return;
      const user = this.leaving || s.reason === 'client_initiated' || s.reason == null;
      const ended = user ? null : s.reason === 'duplicate_identity' ? 'moved' : s.reason === 'participant_removed' ? 'removed' : 'lost';
      const wasActive = this.view.phase !== 'idle';
      // Leave from the notification while JS was awake: tell the server too.
      if (wasActive && s.reason === 'client_initiated' && !this.leaving) void this.server.leaveVoice().catch(() => {});
      if (this.view.ring) void this.engine.ringback(false);
      this.unkey();
      this.undirect();
      this.set({ ...IDLE, ended: wasActive ? ended : this.view.ended, direct: this.view.direct });
      return;
    }
    // Stopped from the system (the projection notification): the server lets the screen go.
    if (this.view.sharing && s.sharing === false) void this.server.releaseScreen().catch(() => {});
    const remote = s.participants.some(p => !p.local);
    if (remote && this.view.ring?.state === 'ringing') void this.engine.ringback(false);
    this.set({
      phase: s.state, room: s.room ?? this.view.room, microphone: s.microphone ?? true, deafened: s.deafened ?? false,
      camera: s.camera ?? false, sharing: s.sharing ?? false, encrypted: s.encrypted ?? false,
      participants: s.participants, route: s.route ?? null, routes: s.routes ?? [],
    });
    this.followDirect(s);
  }

  private async connect(attempt: number, grant: VoiceGrant, options: JoinOptions, key: VoiceKey | null): Promise<void> {
    if (attempt !== this.attempt) return;
    // The room became encrypted between the key and the grant: never connect in clear.
    if (grant.e2ee === true && !key) {
      void this.server.leaveVoice().catch(() => {});
      throw Object.assign(new Error('voice_key_unavailable'), { code: 'voice_key_unavailable' });
    }
    const e2eeKey = grant.e2ee === true ? key : null;
    this.undirect();
    this.directRoom = options.direct === true ? grant.room_id : null;
    this.set({ room: grant.room_id, ring: grant.ring ?? null, direct: options.direct === true });
    this.unkey();
    await this.engine.connect({
      room: grant.room_id, url: grant.url, token: grant.token, title: options.title, link: options.link ?? null,
      microphone: options.microphone && grant.can_publish, e2eeKey: e2eeKey?.key ?? null,
    });
    if (e2eeKey) {
      this.keyed = { room: grant.room_id, epoch: e2eeKey.epoch };
      this.keyTimer = setInterval(() => { void this.refreshKey(); }, KEY_REFRESH_MS);
    }
    if (grant.ring?.state === 'ringing') await this.engine.ringback(true);
  }

  private unkey(): void {
    if (this.keyTimer !== null) clearInterval(this.keyTimer);
    this.keyTimer = null;
    this.keyed = null;
  }

  /**
   * A member or device added or removed moves the room's group to a new
   * epoch, hence a new key: every participant replaces it as it notices.
   */
  async refreshKey(): Promise<void> {
    const keyed = this.keyed;
    if (!keyed) return;
    const next = await this.server.voiceKey(keyed.room).catch(() => null);
    if (!next || this.keyed !== keyed || next.epoch === keyed.epoch) return;
    keyed.epoch = next.epoch;
    await this.engine.setE2eeKey(next.key);
  }

  /** Joins the room's session, leaving any other one. Throws the server's refusal. */
  async join(room: string, options: JoinOptions): Promise<void> {
    const attempt = ++this.attempt;
    this.leaving = false;
    const before = this.view;
    this.set({ phase: 'joining', room, ended: null, ring: null });
    try {
      const key = await this.server.voiceKey(room);
      if (attempt !== this.attempt) return;
      await this.connect(attempt, await this.server.joinVoice(room, options.ring === true, key !== null), options, key);
    } catch (error) {
      if (attempt === this.attempt) this.set({ ...before, phase: before.phase === 'joining' ? 'idle' : before.phase });
      throw error;
    }
  }

  async accept(ring: Pick<VoiceRing, 'id' | 'room_id'>, options: JoinOptions): Promise<void> {
    const attempt = ++this.attempt;
    this.leaving = false;
    this.set({ phase: 'joining', ended: null, ring: null });
    try {
      const key = await this.server.voiceKey(ring.room_id);
      if (attempt !== this.attempt) return;
      await this.connect(attempt, await this.server.acceptRing(ring.id, key !== null), options, key);
    } catch (error) {
      if (attempt === this.attempt) this.set({ phase: 'idle', room: null });
      throw error;
    }
  }

  decline(ring: string): Promise<void> { return this.server.declineRing(ring); }

  async leave(): Promise<void> {
    ++this.attempt;
    this.leaving = true;
    this.unkey();
    this.undirect();
    try {
      await this.engine.ringback(false);
      await this.engine.disconnect();
    } finally {
      this.set({ ...IDLE, direct: this.view.direct });
      this.leaving = false;
      // Best effort: the server also forgets a session the SFU stopped reporting.
      await this.server.leaveVoice().catch(() => {});
    }
  }

  /**
   * The live snapshot's rings for this account: the outgoing call ends when
   * it is declined, missed or cancelled, with the missed-call chime.
   */
  observeRings(rings: readonly VoiceRing[]): void {
    const mine = this.view.ring;
    if (!mine) return;
    const now = rings.find(r => r.id === mine.id);
    if (!now || now.state === mine.state) return;
    this.set({ ring: now });
    if (now.state === 'answered') { void this.engine.ringback(false); return; }
    if (now.state === 'declined' || now.state === 'missed' || now.state === 'cancelled') {
      void this.engine.missed();
      // Alone in a call nobody will answer: hang up.
      if (!this.view.participants.some(p => !p.local)) void this.leave();
    }
  }

  setMicrophone(enabled: boolean): Promise<void> { return this.engine.setMicrophone(enabled); }
  setDeafened(on: boolean): Promise<void> { return this.engine.setDeafened(on); }
  setRoute(route: VoiceRoute): Promise<void> { return this.engine.setRoute(route); }
  setCamera(enabled: boolean): Promise<void> { return this.engine.setCamera(enabled); }

  /**
   * Shares the screen: the server's claim first (one share per room), then
   * Android's consent. A refusal on either side leaves nothing claimed.
   * Throws the server's refusal (screen_taken).
   */
  async shareScreen(): Promise<boolean> {
    await this.server.claimScreen();
    let started = false;
    try {
      started = await this.engine.startScreenShare();
    } finally {
      if (!started) await this.server.releaseScreen().catch(() => {});
    }
    return started;
  }

  async stopScreen(): Promise<void> {
    await this.engine.stopScreenShare();
    await this.server.releaseScreen().catch(() => {});
  }
}
