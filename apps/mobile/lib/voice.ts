/**
 * Voice sessions on a RocketVibe server (docs/protocol/VOICE.md): the server
 * grants, the native engine (modules/voice) speaks WebRTC to LiveKit. One
 * connection per account, so one controller per signed-in native chat.
 *
 * Node-pure: the engine and the server are injected, the tests drive both.
 */
import type { VoiceGrant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import type { VoiceMember, VoiceRoute, VoiceSnapshot } from '../modules/voice/index.ts';

export type VoiceEngine = {
  snapshot(): VoiceSnapshot;
  connect(options: { room: string; url: string; token: string; title: string; link?: string | null; microphone: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  setDeafened(on: boolean): Promise<void>;
  setRoute(route: VoiceRoute): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  startScreenShare(): Promise<boolean>;
  stopScreenShare(): Promise<void>;
  ringback(on: boolean): Promise<void>;
  missed(): Promise<void>;
  addListener(event: 'change', listener: (snapshot: VoiceSnapshot) => void): { remove: () => void };
};
export type VoiceServer = {
  joinVoice(room: string, ring: boolean): Promise<VoiceGrant>;
  leaveVoice(): Promise<void>;
  acceptRing(id: string): Promise<VoiceGrant>;
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
  participants: VoiceMember[];
  route: VoiceRoute | null;
  routes: VoiceRoute[];
  /** The direct call this session rings, until it resolves. */
  ring: VoiceRing | null;
  /** Why the last session ended when the user did not end it. */
  ended: 'moved' | 'removed' | 'lost' | null;
};

const IDLE: VoiceView = {
  phase: 'idle', room: null, microphone: true, deafened: false, camera: false, sharing: false, participants: [],
  route: null, routes: [], ring: null, ended: null,
};

export type JoinOptions = { title: string; link?: string | null; ring?: boolean; microphone: boolean };

export class VoiceController {
  private view: VoiceView = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly subscription: { remove: () => void };
  /** Increments on every join or leave: a late answer of an older one is dropped. */
  private attempt = 0;
  private leaving = false;

  private readonly engine: VoiceEngine;
  private readonly server: VoiceServer;

  constructor(engine: VoiceEngine, server: VoiceServer) {
    this.engine = engine;
    this.server = server;
    this.subscription = engine.addListener('change', s => this.adopt(s));
    // A JS reload finds the call the engine kept.
    this.adopt(engine.snapshot());
  }

  get state(): VoiceView { return this.view; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void { this.subscription.remove(); this.listeners.clear(); }

  private set(next: Partial<VoiceView>): void {
    this.view = { ...this.view, ...next };
    for (const fn of this.listeners) fn();
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
      this.set({ ...IDLE, ended: wasActive ? ended : this.view.ended });
      return;
    }
    // Stopped from the system (the projection notification): the server lets the screen go.
    if (this.view.sharing && s.sharing === false) void this.server.releaseScreen().catch(() => {});
    const remote = s.participants.some(p => !p.local);
    if (remote && this.view.ring?.state === 'ringing') void this.engine.ringback(false);
    this.set({
      phase: s.state, room: s.room ?? this.view.room, microphone: s.microphone ?? true, deafened: s.deafened ?? false,
      camera: s.camera ?? false, sharing: s.sharing ?? false,
      participants: s.participants, route: s.route ?? null, routes: s.routes ?? [],
    });
  }

  private async connect(attempt: number, grant: VoiceGrant, options: JoinOptions): Promise<void> {
    if (attempt !== this.attempt) return;
    this.set({ room: grant.room_id, ring: grant.ring ?? null });
    await this.engine.connect({
      room: grant.room_id, url: grant.url, token: grant.token, title: options.title, link: options.link ?? null,
      microphone: options.microphone && grant.can_publish,
    });
    if (grant.ring?.state === 'ringing') await this.engine.ringback(true);
  }

  /** Joins the room's session, leaving any other one. Throws the server's refusal. */
  async join(room: string, options: JoinOptions): Promise<void> {
    const attempt = ++this.attempt;
    this.leaving = false;
    const before = this.view;
    this.set({ phase: 'joining', room, ended: null, ring: null });
    try {
      await this.connect(attempt, await this.server.joinVoice(room, options.ring === true), options);
    } catch (error) {
      if (attempt === this.attempt) this.set({ ...before, phase: before.phase === 'joining' ? 'idle' : before.phase });
      throw error;
    }
  }

  async accept(ring: string, options: JoinOptions): Promise<void> {
    const attempt = ++this.attempt;
    this.leaving = false;
    this.set({ phase: 'joining', ended: null, ring: null });
    try {
      await this.connect(attempt, await this.server.acceptRing(ring), options);
    } catch (error) {
      if (attempt === this.attempt) this.set({ phase: 'idle', room: null });
      throw error;
    }
  }

  decline(ring: string): Promise<void> { return this.server.declineRing(ring); }

  async leave(): Promise<void> {
    ++this.attempt;
    this.leaving = true;
    try {
      await this.engine.ringback(false);
      await this.engine.disconnect();
    } finally {
      this.set({ ...IDLE });
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
