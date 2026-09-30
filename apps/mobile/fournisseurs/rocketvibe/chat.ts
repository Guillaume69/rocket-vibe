/** Account-scoped native runner: SQLite, durable outbox, journal replay and reconnect. */
import type { Session } from '../../lib/auth.ts';
import { Reconnecteur } from '../../lib/reconnexion.ts';
import { checkIdentity, transportFor } from './auth.ts';
import { NativeStore } from './store.ts';
import { NativeError, type NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';

export type NativeStatus = { online: boolean; error: string | null };
export class NativeChat {
  readonly store: NativeStore;
  readonly transport: NativeTransport;
  private readonly session: Session;
  private readonly id: () => string;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly reconnect: Reconnecteur;
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private generation = 0;
  private stopped = false;
  private verified = false;
  private frames: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastFrame = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private cancelOpening: (() => void) | null = null;
  private flushing: Promise<void> | null = null;
  status: NativeStatus = {online:false,error:null};

  constructor(session: Session, store: NativeStore, id: () => string, options: {
    transport?: NativeTransport; socket?: (url:string) => WebSocket; revoke?: (token:string) => void;
  } = {}) {
    this.session = session; this.store = store; this.id = id;
    this.transport = options.transport ?? transportFor(session,options.revoke);
    this.socketFactory = options.socket ?? (url => new WebSocket(url));
    this.reconnect = new Reconnecteur({connecter: () => this.connect()});
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  start(): void { this.reconnect.declencher(); }
  private disconnect(): void {
    this.generation++;
    this.verified = false;
    const socket = this.socket; this.socket = null;
    this.cancelOpening?.(); this.cancelOpening = null;
    if (socket) { socket.onopen = null; socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); }
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.status = {...this.status,online:false};
    this.notify();
  }
  suspend(): void { this.reconnect.suspendre(); this.disconnect(); }
  resume(): void { if (!this.stopped) { this.reconnect.reprendre(); this.reconnect.declencher(); } }
  refresh(): void { this.disconnect(); this.reconnect.declencher(); }
  stop(): void { this.stopped = true; this.reconnect.arreter(); this.disconnect(); this.listeners.clear(); }

  /** Public seam used by the real-server integration test, also called by Reconnecteur. */
  async connect(): Promise<void> {
    if (this.stopped || this.socket?.readyState === 1) return;
    const generation = this.generation;
    const alive = () => !this.stopped && generation === this.generation;
    try {
      // Finish old socket commits before reading the cursor for a new connection.
      await this.frames;
      checkIdentity(this.session, await this.transport.discover());
      if (!alive()) return;
      const me = await this.transport.me();
      if (me.id !== this.session.userId) throw new NativeError(401,'session_rejected');
      let state = await this.store.state();
      if (!state || state.instance_id !== this.session.nativeInstanceId || state.data_epoch !== this.session.nativeDataEpoch) {
        const snapshot = await this.transport.snapshot();
        if (!alive()) return;
        await this.store.applySnapshot(snapshot);
      } else {
        try {
          for (;;) {
            const batch = await this.transport.changes(state.cursor);
            if (!alive()) return;
            await this.store.applyBatch(batch);
            state = {...state,cursor:batch.cursor};
            if (!batch.has_more) break;
          }
        } catch (error) {
          if (!(error instanceof NativeError) || error.code !== 'sync_reset_required') throw error;
          const snapshot = await this.transport.snapshot();
          if (!alive()) return;
          await this.store.applySnapshot(snapshot);
        }
      }
      if (!alive()) return;
      this.verified = true;
      this.notify();
      await this.flush();
      const cursor = (await this.store.state())!.cursor;
      const url = await this.transport.socketUrl(cursor);
      if (!alive()) return;
      await this.open(url,generation);
      if (!alive()) return;
      this.status = {online:true,error:null}; this.notify();
      this.lastFrame = Date.now();
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastFrame > 45_000) this.lost();
      },15_000);
    } catch (error) {
      if (!alive()) return;
      this.status = {online:false,error:error instanceof NativeError ? error.code : 'connection_failed'};
      this.disconnect();
      if (error instanceof NativeError && (error.code === 'server_identity_changed' || error.code === 'session_rejected')) this.reconnect.arreter();
      throw error;
    }
  }
  private lost(): void { this.disconnect(); if (!this.stopped) this.reconnect.declencher(); }
  private open(url: string, generation: number): Promise<void> {
    return new Promise((resolve,reject) => {
      const socket = this.socketFactory(url); this.socket = socket;
      const timer = setTimeout(() => { reject(new NativeError(0,'socket_timeout')); this.lost(); },15_000);
      this.cancelOpening = () => { clearTimeout(timer); reject(new NativeError(0,'socket_closed')); };
      socket.onopen = () => { clearTimeout(timer); this.cancelOpening = null; socket.onopen = null; resolve(); };
      socket.onerror = socket.onclose = () => {
        clearTimeout(timer); this.cancelOpening = null; reject(new NativeError(0,'socket_closed'));
        if (this.socket === socket) this.lost();
      };
      socket.onmessage = event => {
        if (this.socket !== socket || generation !== this.generation) return;
        this.lastFrame = Date.now();
        // Slow SQLite never creates an unbounded queue. Reconnect replays from the last commit.
        if (this.queued >= 4) { this.lost(); return; }
        this.queued++;
        this.frames = this.frames.then(async () => {
          if (generation !== this.generation || this.stopped) return;
          const batch = decodeNative('SyncBatch',JSON.parse(String(event.data)));
          if (batch.protocol_version !== 1) throw new Error('Unsupported batch version');
          await this.store.applyBatch(batch);
          if (generation === this.generation) this.notify();
        }).catch(() => { if (generation === this.generation) this.lost(); }).finally(() => { this.queued--; });
      };
    });
  }
  private ready(): void { if (!this.verified || this.stopped) throw new NativeError(0,'offline'); }
  async send(rid: string, text: string): Promise<string> {
    if (this.stopped) throw new NativeError(0,'session_closed');
    const value = text.trim();
    let bytes = 0;
    for (const char of value) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
    if (!value || bytes > 32_768) throw new NativeError(400,'invalid_message');
    const id = this.id();
    await this.store.enqueue(id,rid,value); this.notify();
    if (this.verified) await this.flush();
    return id;
  }
  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; return this.flush(); }
    if (!this.verified || this.stopped) return;
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async flushOnce(): Promise<void> {
    for (const pending of await this.store.pending()) {
      if (!this.verified || this.stopped) return;
      try {
        const generation = this.generation;
        const message = await this.transport.send(pending.rid,{operation_id:pending.id,text:pending.texte});
        if (this.stopped || generation !== this.generation) return;
        // The echo and outbox deletion commit together; a failed commit remains retryable.
        await this.store.ingest([message]); this.notify();
      } catch (error) {
        if (this.stopped || !this.verified) return;
        if (!(error instanceof NativeError) || error.status === 0 || error.status >= 500 || error.status === 429 || error.status === 401) return;
        await this.store.fail(pending.id,error.code); this.notify();
      }
    }
  }
  async retry(id: string): Promise<void> { await this.store.retry(id); this.notify(); await this.flush(); }
  async abandon(id: string): Promise<void> { await this.store.abandon(id); this.notify(); }
  async history(rid: string, older = false): Promise<boolean> {
    this.ready();
    const generation = this.generation;
    const before = older ? await this.store.oldestPosition(rid) : undefined;
    const page = await this.transport.history(rid,before);
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    await this.store.ingest(page.messages); this.notify();
    return page.has_more;
  }
  async createRoom(name: string, privateRoom: boolean): Promise<string> {
    this.ready();
    const generation = this.generation;
    const room = await this.transport.createRoom({name:name.trim(),private:privateRoom});
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    // The next journal batch provides authoritative membership and the durable cursor.
    this.refresh(); return room.id;
  }
  async direct(username: string): Promise<string> {
    this.ready();
    const user = (await this.transport.users()).find(user => user.username === username.trim());
    if (!user) throw new NativeError(404,'user_not_found');
    this.ready();
    const room = await this.transport.direct({user_id:user.id});
    this.refresh(); return room.id;
  }
  async invite(rid: string, username: string): Promise<void> {
    this.ready();
    const user = (await this.transport.users()).find(user => user.username === username.trim());
    if (!user) throw new NativeError(404,'user_not_found');
    this.ready();
    await this.transport.addMember(rid,user.id);
  }
}
