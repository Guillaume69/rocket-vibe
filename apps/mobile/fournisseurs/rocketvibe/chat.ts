/** Account-scoped native runner: SQLite, durable outbox, journal replay and reconnect. */
import type { Session } from '../../lib/auth.ts';
import { Reconnecteur } from '../../lib/reconnexion.ts';
import { checkIdentity, transportFor } from './auth.ts';
import { NativeStore, type NativeCommand } from './store.ts';
import { NativeError, type NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';
import type { Capabilities } from './protocol.generated.ts';

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
  private commands: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private retryAttempt = 0;
  status: NativeStatus = {online:false,error:null};
  capabilities: Capabilities | null = null;

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
    if (this.retryTimer!==null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
      const discovery = await this.transport.discover();
      checkIdentity(this.session, discovery);
      if (!alive()) return;
      this.capabilities = discovery.capabilities;
      const me = await this.transport.me();
      if (me.id !== this.session.userId) throw new NativeError(401,'session_rejected');
      let state = await this.store.state();
      if (!state || state.instance_id !== this.session.nativeInstanceId || state.data_epoch !== this.session.nativeDataEpoch) {
        const snapshot = await this.transport.snapshot();
        if (!alive()) return;
        checkIdentity(this.session, await this.transport.discover());
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
          checkIdentity(this.session, await this.transport.discover());
          if (!alive()) return;
          await this.store.applySnapshot(snapshot);
        }
      }
      if (!alive()) return;
      this.verified = true;
      this.notify();
      await this.flush();
      if (!alive()) return;
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
      if (error instanceof NativeError && (error.code === 'server_identity_changed' || error.code === 'session_rejected')) this.stop();
      else this.disconnect();
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
  private ready(): void {
    if (this.stopped) throw new NativeError(0,'session_closed');
    if (!this.verified) throw new NativeError(0,'offline');
  }
  async messagePermissions(id: string): Promise<import('./protocol.generated.ts').MessagePermissions> {
    this.ready();
    if (!this.capabilities?.fine_permissions) throw new NativeError(501,'unsupported_feature');
    const generation=this.generation;
    const permissions=await this.transport.messagePermissions(id);
    if (this.stopped || generation!==this.generation) throw new NativeError(0,'session_closed');
    return permissions;
  }
  async actionContext(id: string): Promise<{message:import('./protocol.generated.ts').Message;permissions:import('./protocol.generated.ts').MessagePermissions;draft:string|null}> {
    this.ready();
    const generation=this.generation;
    const projection=this.store.projectionToken();
    const message=await this.transport.message(id);
    const permissions=await this.messagePermissions(id);
    if (this.stopped || generation!==this.generation) throw new NativeError(0,'session_closed');
    if (permissions.revision!==message.revision) throw new NativeError(409,'delivery_revalidate');
    if (!await this.store.ingest([message],projection)) throw new NativeError(409,'delivery_revalidate');
    this.notify();
    if (message.deleted) throw new NativeError(410,'message_deleted');
    return {message,permissions,draft:await this.store.commandDraft(id)};
  }
  async edit(rid: string,id: string,revision: string,text: string): Promise<void> {
    if (!text.trim() || utf8RoomBytes(text)>32_768) throw new NativeError(400,'invalid_message');
    return this.submitCommand(rid,id,revision,'edit',text);
  }
  async delete(rid: string,id: string,revision: string): Promise<void> {
    return this.submitCommand(rid,id,revision,'delete','');
  }
  private async submitCommand(rid: string,id: string,revision: string,kind: NativeCommand['kind'],text: string): Promise<void> {
    this.ready();
    const command=await this.store.command(rid,id,revision,kind,text,this.id);
    if (!command) throw new NativeError(409,'message_action_pending');
    try { await this.applyCommand(command); }
    catch (error) { await this.commandFailed(command,error); throw error; }
  }
  private async applyCommand(command: NativeCommand): Promise<void> {
    const operation=this.commands.then(async () => {
      this.ready();
      if (!(command.kind==='edit'?this.capabilities?.editing:this.capabilities?.deletion)) throw new NativeError(501,'unsupported_feature');
      const generation=this.generation;
      const projection=this.store.projectionToken();
      const input={operation_id:command.id,expected_revision:command.expected_revision};
      const message=command.kind==='edit'
        ? await this.transport.editMessage(command.message_id,{...input,content:{kind:'plain',markdown:command.text,mentions:[],quotes:[],files:[]}})
        : await this.transport.deleteMessage(command.message_id,input);
      if (this.stopped || generation!==this.generation) throw new NativeError(0,'session_closed');
      if (!await this.store.confirmCommand(command.id,message,projection)) throw new NativeError(409,'delivery_revalidate');
      this.retryAttempt=0; this.retryAt=0; this.notify();
    });
    this.commands=operation.catch(() => {});
    return operation;
  }
  private async commandFailed(command: NativeCommand,error: unknown): Promise<void> {
    if (this.stopped || !this.verified) return;
    if (permanentCommandError(error)) { await this.store.failCommand(command.id,(error as NativeError).code); this.notify(); }
    else if (error instanceof NativeError && error.status===401 && error.code==='session_rejected') {
      this.status={online:false,error:error.code}; this.stop();
    } else {
      this.deferSend(error);
      if (error instanceof NativeError && error.code==='delivery_revalidate') this.lost();
    }
  }
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
    if (Date.now()<this.retryAt) { this.armRetry(); return; }
    this.flushing = this.flushOnce().catch(error => {
      if (this.verified && !this.stopped) this.deferSend(error);
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private armRetry(): void {
    if (this.retryTimer!==null) clearTimeout(this.retryTimer);
    if (!this.verified || this.stopped) { this.retryTimer=null; return; }
    this.retryTimer=setTimeout(() => { this.retryTimer=null; void this.flush(); },Math.max(1,this.retryAt-Date.now()));
  }
  private deferSend(error: unknown): void {
    const ceiling=Math.min(30_000,1000*2**Math.min(this.retryAttempt++,5));
    const delay=error instanceof NativeError && error.status===429
      ? Math.min(300,Math.max(1,error.retryAfter??1))*1000+Math.random()*250
      : ceiling/2+Math.random()*ceiling/2;
    this.retryAt=Date.now()+delay;
    this.armRetry();
  }
  private async flushOnce(): Promise<void> {
    for (const pending of await this.store.pending()) {
      if (!this.verified || this.stopped) return;
      try {
        const generation = this.generation;
        const projection=this.store.projectionToken();
        const message = await this.transport.send(pending.rid,{operation_id:pending.id,text:pending.texte});
        if (this.stopped || generation !== this.generation) return;
        // The echo and outbox deletion commit together; a failed commit remains retryable.
        if (!await this.store.ingest([message],projection)) throw new NativeError(409,'delivery_revalidate');
        this.notify();
        this.retryAttempt=0; this.retryAt=0;
      } catch (error) {
        if (this.stopped || !this.verified) return;
        if (error instanceof NativeError && error.status===401 && error.code==='session_rejected') {
          this.status={online:false,error:error.code}; this.stop(); return;
        }
        if (error instanceof NativeError && error.code === 'delivery_revalidate') { this.deferSend(error); this.lost(); return; }
        if (!(error instanceof NativeError) || error.status === 0 || error.status >= 500 || error.status === 429 || error.status === 401) { this.deferSend(error); return; }
        await this.store.fail(pending.id,error.code); this.notify();
      }
    }
    for (const command of await this.store.pendingCommands()) {
      if (!this.verified || this.stopped) return;
      try { await this.applyCommand(command); }
      catch (error) { await this.commandFailed(command,error); if (!permanentCommandError(error)) return; }
    }
  }
  async retry(id: string): Promise<void> { await this.store.retry(id); this.notify(); await this.flush(); }
  async abandon(id: string): Promise<void> { await this.store.abandon(id); this.notify(); }
  async history(rid: string, older = false): Promise<boolean> {
    this.ready();
    const generation = this.generation;
    const projection=this.store.projectionToken();
    const before = older ? await this.store.oldestPosition(rid) : undefined;
    const page = await this.transport.history(rid,before);
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    if (!await this.store.ingest(page.messages,projection)) throw new NativeError(409,'delivery_revalidate');
    this.notify();
    return page.has_more;
  }
  async createRoom(name: string, privateRoom: boolean): Promise<string> {
    this.ready();
    const generation = this.generation;
    name=name.trim();
    if (!name || utf8RoomBytes(name)>128) throw new NativeError(400,'invalid_request');
    const operation = this.capabilities?.idempotent_room_creation ? await this.store.roomCreation(name,privateRoom,this.id) : undefined;
    const room = await this.transport.createRoom({name,private:privateRoom,...(operation?{operation_id:operation}:{})});
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    if (operation) await this.store.completeRoomCreation(operation);
    // The next journal batch provides authoritative membership and the durable cursor.
    this.refresh(); return room.id;
  }
  async direct(username: string): Promise<string> {
    this.ready();
    const generation = this.generation;
    const user = (await this.transport.users()).find(user => user.username === username.trim());
    if (!user) throw new NativeError(404,'user_not_found');
    this.ready();
    const room = await this.transport.direct({user_id:user.id});
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    this.refresh(); return room.id;
  }
  async invite(rid: string, username: string): Promise<void> {
    this.ready();
    const user = (await this.transport.users()).find(user => user.username === username.trim());
    if (!user) throw new NativeError(404,'user_not_found');
    this.ready();
    await this.transport.addMember(rid,user.id);
  }
  async users(): Promise<import('./protocol.generated.ts').User[]> {
    this.ready();
    const generation = this.generation;
    const users = await this.transport.users();
    if (this.stopped || generation !== this.generation) throw new NativeError(0,'session_closed');
    return users;
  }
  async publicRooms(query: string): Promise<import('./protocol.generated.ts').PublicRoomPage> {
    this.ready();
    if (!this.capabilities?.room_discovery) return {rooms:[],next:null};
    const generation=this.generation;
    const page=await this.transport.publicRooms(query);
    if (this.stopped || generation!==this.generation) throw new NativeError(0,'session_closed');
    return page;
  }
  async joinPublic(rid: string): Promise<string> {
    this.ready();
    if (!this.capabilities?.room_discovery) throw new NativeError(501,'unsupported_feature');
    const generation=this.generation;
    const room=await this.transport.joinPublic(rid);
    if (this.stopped || generation!==this.generation) throw new NativeError(0,'session_closed');
    this.refresh(); return room.id;
  }
}

function permanentCommandError(error: unknown): boolean {
  return error instanceof NativeError && error.status>=400 && error.status<500 && error.status!==401 && error.status!==429 && error.code!=='delivery_revalidate'
    || error instanceof NativeError && error.code==='unsupported_feature';
}

function utf8RoomBytes(value: string): number {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./g,'x').length;
}
