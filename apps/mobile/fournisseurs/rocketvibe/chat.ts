/** Account-scoped native runner: SQLite, durable outbox, journal replay and reconnect. */
import type { Session } from '../../lib/auth.ts';
import { Reconnecteur } from '../../lib/reconnexion.ts';
import { checkIdentity, transportFor } from './auth.ts';
import { NativeStore, type NativeCommand } from './store.ts';
import { NativeError, type NativeTransport } from './transport.ts';
import {avatarOctets,type ProfileOperation,type ProfileSlot,type SavedProfileOperation} from './profileOperations.ts';
import {avatarBase64} from '../../lib/avatarsNatifs.ts';
import type {MonProfil} from '../../lib/monProfil.ts';
import { decodeNative } from './validation.ts';
import type { Capabilities } from './protocol.generated.ts';
import type {RoomOperation,SavedRoomOperation} from './roomOperations.ts';
import type {PendingRead,SavedFavorite} from './readIntents.ts';
import { canonicalEmoji } from './emojis.ts';
import {NativeLive} from './live.ts';
import type {FactorRemote} from './factorVault.ts';
import type {EmailRemote} from './emailVault.ts';
import {checkSecurityScope,type SecurityScope} from './reauthenticationVault.ts';

export type NativeStatus = { online: boolean; error: string | null };
export class NativeChat {
  readonly live=new NativeLive();
  private presenceTimer:ReturnType<typeof setInterval>|null=null;
  private presenceCommands:Promise<void>=Promise.resolve();
  private typingDesired:{room:string;input:import('./protocol.generated.ts').SetTyping;generation:number}|null=null;
  private typingRunning=false;
  private typingLast:{key:string;at:number}|null=null;
  readonly store: NativeStore;
  readonly transport: NativeTransport;
  private session: Session;
  private readonly credentials:((session:Session)=>Promise<Session>)|undefined;
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
  private roomAccessReads = new Map<string,Promise<void>>();
  private profileHeads=new Map<string,string>();
  private livePeers=new Map<string,string>();
  private profileChanges=0;
  private profileReads:Promise<void>=Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private retryAttempt = 0;
  private stateFlushing:Promise<void>|null=null;
  private stateRetryTimer:ReturnType<typeof setTimeout>|null=null;
  private readRetryAt=0;
  private favoriteRetryAt=0;
  private credentialCheckAt=Date.now()+24*60*60*1000;
  status: NativeStatus = {online:false,error:null};
  capabilities: Capabilities | null = null;

  constructor(session: Session, store: NativeStore, id: () => string, options: {
    transport?: NativeTransport; socket?: (url:string) => WebSocket; revoke?: (token:string) => void;
    credentials?:(session:Session)=>Promise<Session>;
  } = {}) {
    this.session = session; this.store = store; this.id = id;
    this.credentials=options.credentials;
    this.transport = options.transport ?? transportFor(session,options.revoke);
    this.socketFactory = options.socket ?? (url => new WebSocket(url));
    this.reconnect = new Reconnecteur({connecter: () => this.connect()});
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get searchVersion():string {return `${this.generation}:${this.store.projectionToken()}:${this.store.searchToken()}`;}
  get profileVersion():string {return `${this.generation}:${this.store.projectionToken()}:${this.profileChanges}`;}
  profileVersionFor(id:string|null):string {return `${this.generation}:${this.store.projectionToken()}:${id?this.profileHeads.get(id)??'unobserved':this.profileChanges}`;}
  private notify(): void { for (const listener of this.listeners) listener(); }
  start(): void { this.reconnect.declencher(); }
  private disconnect(): void {
    if(this.verified && this.capabilities?.presence)this.emitPresence('offline');
    if(this.presenceTimer!==null)clearInterval(this.presenceTimer);
    this.presenceTimer=null;this.typingDesired=null;this.typingLast=null;this.live.clear();
    this.profileHeads.clear();this.livePeers.clear();
    this.generation++;
    this.verified = false;
    if (this.retryTimer!==null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if(this.stateRetryTimer!==null)clearTimeout(this.stateRetryTimer);
    this.stateRetryTimer=null;
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
      if (this.credentials && discovery.capabilities.session_rotation) {
        const fresh=await this.credentials(this.session);
        if(!alive())return;
        checkIdentity(fresh,discovery);
        if(fresh.baseUrl!==this.session.baseUrl || fresh.userId!==this.session.userId)throw new NativeError(401,'session_rejected');
        this.session=fresh;this.transport.restore(fresh.authToken);
        this.credentialCheckAt=Date.now()+24*60*60*1000;
      }
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
      if(discovery.capabilities.read_markers && (await this.store.rooms()).length){
        let unstamped=false;
        for(const room of await this.store.rooms())if(!(await this.store.readState(room.rid))?.membership_version){unstamped=true;break;}
        if(unstamped){
          const snapshot=await this.transport.snapshot();if(!alive())return;
          checkIdentity(this.session,await this.transport.discover());if(!alive())return;
          await this.store.applySnapshot(snapshot);
        }
      }
      if (!alive()) return;
      this.verified = true;
      this.notify();
      await this.flush();
      if (!alive()) return;
      const cursor = (await this.store.state())!.cursor;
      const url = await this.transport.socketUrl(cursor,!!(this.capabilities?.typing || this.capabilities?.presence));
      if (!alive()) return;
      await this.open(url,generation);
      if (!alive()) return;
      this.status = {online:true,error:null}; this.notify();
      if(this.capabilities?.presence){this.emitPresence('online');this.presenceTimer=setInterval(()=>this.emitPresence('online'),20_000);}
      this.lastFrame = Date.now();
      this.watchdog = setInterval(() => {
        if(this.credentials && Date.now()>=this.credentialCheckAt){this.refresh();return;}
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
        const receivedAt=performance.now();
        // Slow SQLite never creates an unbounded queue. Reconnect replays from the last commit.
        if (this.queued >= 4) { this.lost(); return; }
        this.queued++;
        this.frames = this.frames.then(async () => {
          if (generation !== this.generation || this.stopped) return;
          const value:unknown=JSON.parse(String(event.data));
          if(value && typeof value==='object' && 'type' in value && value.type==='live'){
            const frame=decodeNative('LiveFrame',value);
            for(const room of frame.data.rooms){
              const grant=await this.store.readState(room.room_id);
              if(generation!==this.generation)return;
              if(grant?.membership_version!==room.membership_version){this.live.clear();return;}
            }
            if(generation===this.generation && !frame.data.limited && frame.data.ttl_ms<=8000 && frame.data.ttl_ms>performance.now()-receivedAt){
              const profiles=frame.data.profiles??[];
              if(profiles.length>512 || new Set(profiles.map(p=>p.user.id)).size!==profiles.length)throw new NativeError(0,'invalid_profile_page');
              const changed=profiles.filter(p=>this.profileHeads.get(p.user.id)!==p.revision);
              const peerKey=(room:import('./protocol.generated.ts').LiveRoom)=>room.direct_peer?`${room.direct_peer.id}:${room.direct_peer.username}`:'';
              const peers=frame.data.rooms.filter(room=>(room.direct_peer!=null||this.livePeers.has(room.room_id))&&this.livePeers.get(room.room_id)!==peerKey(room));
              this.livePeers=new Map(frame.data.rooms.filter(room=>room.direct_peer!=null).map(room=>[room.room_id,peerKey(room)]));
              const profileChanged=changed.length>0||profiles.length!==this.profileHeads.size;
              if(profileChanged)this.profileChanges++;
              this.profileHeads=new Map(profiles.map(p=>[p.user.id,p.revision]));
              const projection=this.store.projectionToken();
              if(changed.length||peers.length)await this.store.profileIdentities(changed,()=>generation===this.generation && !this.stopped && projection===this.store.projectionToken(),peers);
              if(generation===this.generation)this.live.apply(frame.data,Math.max(0,performance.now()-receivedAt));
              if(generation===this.generation && profileChanged)this.notify();
            }
            else if(generation===this.generation)this.live.clear();
            return;
          }
          const batch = decodeNative('SyncBatch',value);
          if (batch.protocol_version !== 1) throw new Error('Unsupported batch version');
          await this.store.applyBatch(batch);
          for(const room of this.live.state?.rooms??[])if((await this.store.readState(room.room_id))?.membership_version!==room.membership_version){this.live.clear();break;}
          if (generation === this.generation) this.notify();
        }).catch(() => { if (generation === this.generation) this.lost(); }).finally(() => { this.queued--; });
      };
    });
  }
  private ready(): void {
    if (this.stopped) throw new NativeError(0,'session_closed');
    if (!this.verified) throw new NativeError(0,'offline');
  }
  private emitPresence(status:import('./protocol.generated.ts').PresenceStatus):void {
    const generation=this.generation;
    this.presenceCommands=this.presenceCommands.then(async()=>{
      if(status!=='offline' && (generation!==this.generation || this.stopped || !this.status.online))return;
      await this.transport.setPresence(status);
    }).catch(()=>{});
  }
  async setTyping(room:string,active:boolean,rootId?:string,membership?:string):Promise<void>{
    if(!this.status.online || !this.capabilities?.typing || this.stopped)return;
    const generation=this.generation,grant=await this.store.readState(room);
    if(generation!==this.generation || !grant?.membership_version || membership && membership!==grant.membership_version)return;
    const key=`${room}:${rootId??''}:${grant.membership_version}`;
    if(active && this.typingLast?.key===key && performance.now()-this.typingLast.at<3000)return;
    this.typingLast=active?{key,at:performance.now()}:null;
    this.typingDesired={room,input:{active,membership_version:grant.membership_version,...(rootId?{root_id:rootId}:{})},generation};
    if(this.typingRunning)return;
    this.typingRunning=true;
    try {
      while(this.typingDesired){
        const desired=this.typingDesired;this.typingDesired=null;
        if(desired.generation!==this.generation || !this.status.online)continue;
        if((await this.store.readState(desired.room))?.membership_version!==desired.input.membership_version)continue;
        if(desired.generation!==this.generation || !this.status.online)continue;
        await this.transport.setTyping(desired.room,desired.input).catch(()=>{});
      }
    } finally {this.typingRunning=false;}
  }
  async roomMembers(room:string,after?:string,revision?:string):Promise<import('./protocol.generated.ts').RoomMemberPage> {
    this.ready();
    if(!this.capabilities?.room_info)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,projection=this.store.projectionToken();
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    const page=await this.transport.roomMembers(room,after,revision);
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    if(page.room_id!==room || revision!==undefined && page.revision!==revision)throw new NativeError(409,'invalid_room_members');
    if(projection!==this.store.projectionToken() || !(await this.store.rooms()).some(r=>r.rid===room))throw new NativeError(409,'delivery_revalidate');
    return page;
  }
  async updateRoom(room:string,input:Omit<import('./protocol.generated.ts').UpdateRoom,'operation_id'>):Promise<void> {
    await this.submitRoomOperation(room,{kind:'settings',input:{...input,operation_id:this.id()}});
  }
  async changeRoomRole(room:string,target:string,input:Omit<import('./protocol.generated.ts').ChangeRoomRole,'operation_id'>):Promise<void> {
    await this.submitRoomOperation(room,{kind:'role',target,input:{...input,operation_id:this.id()}});
  }
  async leaveRoom(room:string,revision:string):Promise<void> {
    await this.submitRoomOperation(room,{kind:'leave',input:{operation_id:this.id(),expected_revision:revision}});
  }
  async resumeRoomOperation(room:string):Promise<void> {
    this.ready();
    const saved=await this.store.roomOperation(room);
    if(!saved)throw new NativeError(409,'room_operation_missing');
    if(saved.failed)throw new NativeError(409,'room_action_failed');
    try{await this.applyRoomOperation(saved);}catch(error){await this.roomOperationFailed(saved,error);throw error;}
  }
  async dismissRoomOperation(room:string,id:string):Promise<boolean> {
    const operation=this.commands.then(async()=>{this.ready();return this.store.dismissRoomOperation(room,id);});
    this.commands=operation.then(()=>{},()=>{});
    const dismissed=await operation;this.notify();return dismissed;
  }
  private roomCommandSupported(command:RoomOperation):boolean {
    return !!(command.kind==='settings'?this.capabilities?.room_settings:command.kind==='role'?this.capabilities?.room_roles:this.capabilities?.room_leave);
  }
  private roomOperationGeneration(generation:number):void {
    this.ready();if(generation!==this.generation)throw new NativeError(0,'session_closed');
  }
  private async submitRoomOperation(room:string,command:RoomOperation):Promise<void> {
    this.ready();
    if(!this.roomCommandSupported(command))throw new NativeError(501,'unsupported_feature');
    const saved=await this.store.stageRoomOperation(room,command);
    if(!saved)throw new NativeError(409,'room_action_pending');
    this.notify();
    try{await this.applyRoomOperation(saved);}catch(error){await this.roomOperationFailed(saved,error);throw error;}
  }
  private async applyRoomOperation(saved:SavedRoomOperation):Promise<void> {
    const operation=this.commands.then(async()=>{
      this.ready();const generation=this.generation;
      const live=async()=>{const current=await this.store.roomOperation(saved.room);return !!current && !current.failed && current.command.input.operation_id===saved.command.input.operation_id;};
      if(!await live())return;
      const discovery=await this.transport.discover();checkIdentity(this.session,discovery);this.roomOperationGeneration(generation);
      this.capabilities=discovery.capabilities;
      if(!await live())return;
      let receipt:import('./protocol.generated.ts').RoomCommandReceipt;
      try{receipt=await this.transport.roomCommandReceipt(saved.room,saved.command.input.operation_id);}
      catch(error){
        if(!(error instanceof NativeError) || error.status!==404 || error.code!=='not_found')throw error;
        this.roomOperationGeneration(generation);
        if(!await live())return;
        if(!this.roomCommandSupported(saved.command))throw new NativeError(501,'unsupported_feature');
        receipt=saved.command.kind==='settings'?await this.transport.updateRoom(saved.room,saved.command.input)
          :saved.command.kind==='role'?await this.transport.changeRoomRole(saved.room,saved.command.target,saved.command.input)
          :await this.transport.leaveRoom(saved.room,saved.command.input);
      }
      checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
      if(receipt.operation_id!==saved.command.input.operation_id || receipt.room_id!==saved.room)throw new NativeError(409,'invalid_room_receipt');
      await this.store.confirmRoomOperation(receipt);
      this.retryAttempt=0;this.retryAt=0;this.notify();
    });
    this.commands=operation.catch(()=>{});return operation;
  }
  private async roomOperationFailed(saved:SavedRoomOperation,error:unknown):Promise<void> {
    if(this.stopped || !this.verified)return;
    if(permanentRoomError(error)){await this.store.failRoomOperation(saved.room,saved.command.input.operation_id,(error as NativeError).code);this.notify();}
    else if(error instanceof NativeError && ['session_rejected','server_identity_changed'].includes(error.code)){this.status={online:false,error:error.code};this.stop();}
    else{this.deferSend(error);if(error instanceof NativeError && error.code==='delivery_revalidate')this.lost();}
  }
  async roomDetails(room: string):Promise<import('./protocol.generated.ts').RoomDetails> {
    this.ready();
    if(!this.capabilities?.room_info)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,projection=this.store.projectionToken();
    checkIdentity(this.session,await this.transport.discover());
    this.ready();
    if(generation!==this.generation)throw new NativeError(0,'session_closed');
    const details=await this.transport.roomDetails(room);
    this.ready();
    if(generation!==this.generation)throw new NativeError(0,'session_closed');
    if(details.room.id!==room || details.permissions.room_id!==room)throw new NativeError(502,'invalid_room_details');
    if(projection!==this.store.projectionToken())throw new NativeError(409,'delivery_revalidate');
    checkIdentity(this.session,await this.transport.discover());
    this.ready();
    if(generation!==this.generation || projection!==this.store.projectionToken())throw new NativeError(409,'delivery_revalidate');
    await this.store.cacheRoomAccess(details,projection);
    this.ready();
    if(generation!==this.generation)throw new NativeError(0,'session_closed');
    return details;
  }
  refreshRoomAccess(room:string):Promise<void> {
    const previous=this.roomAccessReads.get(room);
    if(previous)return previous;
    const request=(async()=>{
      this.ready();
      if(!this.capabilities?.room_info)return;
      for(let attempt=0;attempt<3;attempt++) {
        const access=await this.store.roomAccess(room);
        if(!access || access.can_send!=null)return;
        await this.roomDetails(room);
        const fresh=await this.store.roomAccess(room);
        if(!fresh || fresh.can_send!=null || fresh.revision===access.revision)return;
      }
    })();
    this.roomAccessReads.set(room,request);
    void request.finally(()=>{if(this.roomAccessReads.get(room)===request)this.roomAccessReads.delete(room);}).catch(()=>{});
    return request;
  }
  private deviceAccess():number {
    this.ready();
    if(!this.capabilities?.device_sessions)throw new NativeError(501,'unsupported_feature');
    return this.generation;
  }
  /** Capture the connected runner generation, never expose a raw transport to
   * a retained settings callback after logout, suspension or account switch. */
  async security(visible:()=>boolean=()=>true):Promise<{scope:SecurityScope;remote:FactorRemote;email:EmailRemote;alive:()=>boolean}> {
    this.ready();
    if(!this.capabilities?.reauthentication || !this.capabilities.reauthentication_retirement)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,alive=()=>visible() && !this.stopped && this.verified && generation===this.generation;
    const call=async<T>(action:()=>Promise<T>):Promise<T>=>{
      if(!alive())throw new NativeError(0,'session_closed');
      checkIdentity(this.session,await this.transport.discover());
      if(!alive())throw new NativeError(0,'session_closed');
      const result=await action();
      if(!alive())throw new NativeError(0,'session_closed');
      return result;
    };
    const status=await call(()=>this.transport.reauthenticationStatus());
    const scope:SecurityScope={baseUrl:this.session.baseUrl,user_id:this.session.userId,device_id:status.device_id,instance_id:this.session.nativeInstanceId!,data_epoch:this.session.nativeDataEpoch!};
    checkSecurityScope(scope,status);
    const factorCall=async<T>(action:()=>Promise<T>):Promise<T>=>{
      if(!this.capabilities?.second_factors)throw new NativeError(501,'unsupported_feature');
      return call(action);
    };
    const emailCall=async<T>(action:()=>Promise<T>,verificationOnly=false):Promise<T>=>{
      if(verificationOnly?!this.capabilities?.email_verification:!(this.capabilities?.email_verification || this.capabilities?.email_removal || this.capabilities?.email_factors))throw new NativeError(501,'unsupported_feature');
      return call(action);
    };
    const removalCall=async<T>(action:()=>Promise<T>):Promise<T>=>{
      if(!this.capabilities?.email_removal)throw new NativeError(501,'unsupported_feature');
      return call(action);
    };
    return {scope,alive,email:{
      status:()=>emailCall(()=>this.transport.emailStatus()),begin:input=>emailCall(()=>this.transport.beginEmailVerification(input),true),
      resume:input=>emailCall(()=>this.transport.resumeEmailVerification(input)),confirm:input=>emailCall(()=>this.transport.confirmEmailVerification(input)),
      retire:input=>emailCall(()=>this.transport.retireEmailVerification(input)),
      ...(this.capabilities?.email_removal?{removal:{
        begin:input=>removalCall(()=>this.transport.removeVerifiedEmail(input)),
        resume:input=>removalCall(()=>this.transport.resumeEmailRemoval(input)),
        retire:input=>removalCall(()=>this.transport.retireEmailRemoval(input)),
      }}:{}),
    },remote:{
      proof:{status:()=>call(async()=>{const next=await this.transport.reauthenticationStatus();checkSecurityScope(scope,next);return next;}),
        begin:input=>call(()=>this.transport.beginReauthentication(input)),resume:input=>call(()=>this.transport.resumeReauthentication(input)),
        finish:input=>call(()=>this.transport.finishReauthentication(input)),retire:input=>call(()=>this.transport.retireReauthentication(input)),
        ...(this.capabilities?.email_factors?{email:{
          begin:input=>call(()=>{if(!this.capabilities?.email_factor_delivery)throw new NativeError(501,'unsupported_feature');return this.transport.beginReauthenticationEmail(input);}),
          resume:input=>call(()=>this.transport.resumeReauthenticationEmail(input)),
        }}:{}),
      },
      status:()=>call(()=>this.transport.factorStatus()),setup:input=>factorCall(()=>this.transport.beginFactorSetup(input)),
      enable:input=>factorCall(()=>this.transport.enableFactor(input)),regenerate:input=>factorCall(()=>this.transport.regenerateFactorBackups(input)),
      disable:input=>factorCall(()=>this.transport.disableFactor(input)),
      ...(this.capabilities?.email_factors?{emailSettings:{
        status:()=>emailCall(()=>this.transport.emailStatus()),
        change:(input:import('./protocol.generated.ts').ChangeEmailFactor,enabled:boolean)=>call(()=>{
          if(!this.capabilities?.email_factors)throw new NativeError(501,'unsupported_feature');
          return enabled?this.transport.enableEmailFactor(input):this.transport.disableEmailFactor(input);
        }),
      }}:{}),
    }};
  }
  async deviceSessions():Promise<import('./protocol.generated.ts').DeviceSession[]> {
    const generation=this.deviceAccess();
    const devices=await this.transport.deviceSessions();
    if(this.stopped || generation!==this.generation)throw new NativeError(0,'session_closed');
    if(devices.filter(d=>d.current).length!==1 || new Set(devices.map(d=>d.id)).size!==devices.length)throw new NativeError(502,'invalid_native_session');
    return devices;
  }
  async renameDevice(id:string,label:string):Promise<void> {
    const generation=this.deviceAccess();await this.transport.renameDevice(id,label);
    if(this.stopped || generation!==this.generation)throw new NativeError(0,'session_closed');
  }
  async revokeDevice(id:string):Promise<void> {
    const generation=this.deviceAccess();
    if((await this.deviceSessions()).some(d=>d.id===id && d.current))throw new NativeError(409,'current_device_requires_logout');
    if(this.stopped || generation!==this.generation)throw new NativeError(0,'session_closed');
    await this.transport.revokeDevice(id);
    if(this.stopped || generation!==this.generation)throw new NativeError(0,'session_closed');
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
  async react(rid:string,id:string,code:string,present:boolean):Promise<void> {
    const emoji=canonicalEmoji(code);
    if (!emoji) throw new NativeError(422,'unknown_emoji');
    return this.submitCommand(rid,id,'0','react',JSON.stringify({emoji,present}));
  }
  async setMark(rid:string,id:string,present:boolean,starred:boolean):Promise<void> {
    return this.submitCommand(rid,id,'0',starred?'star':'pin',JSON.stringify(present));
  }
  async ownProfile():Promise<import('./protocol.generated.ts').OwnProfile> {
    this.ready();if(!this.capabilities?.profiles)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,projection=this.store.projectionToken();
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    const own=await this.transport.ownProfile();
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    if(own.profile.user.id!==this.session.userId)throw new NativeError(401,'session_rejected');
    if(projection!==this.store.projectionToken())throw new NativeError(409,'delivery_revalidate');
    await this.store.profileIdentities([own.profile],()=>generation===this.generation&&!this.stopped&&projection===this.store.projectionToken());
    this.roomOperationGeneration(generation);return own;
  }
  async changeProfile(command:ProfileOperation):Promise<import('./protocol.generated.ts').OwnProfile> {
    if(this.stopped)throw new NativeError(0,'session_closed');
    if(!this.capabilities?.profiles)throw new NativeError(501,'unsupported_feature');
    const saved=await this.store.profileOperations.stage(command);
    if(!saved)throw new NativeError(409,'profile_action_pending');
    if(saved.phase==='proof')throw new NativeError(403,'reauthentication_required');
    this.notify();
    this.ready();
    try{return await this.applyProfileOperation(saved);}catch(error){await this.profileOperationFailed(saved,error);throw error;}
  }
  editOwnProfile(value:MonProfil):Promise<import('./protocol.generated.ts').OwnProfile> {
    if(!value.revision)throw new NativeError(409,'revision_required');
    return this.changeProfile({kind:'profile',input:{operation_id:this.id(),expected_revision:value.revision,username:value.username,display_name:value.name,bio:value.bio,status:value.status,status_text:value.statusText}});
  }
  setOwnAvatar(revision:string,upload?:{mime:string;bytes:Uint8Array}):Promise<import('./protocol.generated.ts').OwnProfile> {
    if(upload&&!['image/png','image/jpeg'].includes(upload.mime))throw new NativeError(422,'invalid_avatar');
    return this.changeProfile({kind:'avatar',input:{operation_id:this.id(),expected_revision:revision},upload:upload?{mime:upload.mime as 'image/png'|'image/jpeg',base64:avatarBase64(upload.bytes)}:null});
  }
  updateOwnPreferences(before:import('./protocol.generated.ts').UserPreferences,changes:Partial<Omit<import('./protocol.generated.ts').UserPreferences,'revision'>>):Promise<import('./protocol.generated.ts').OwnProfile> {
    return this.changeProfile({kind:'preferences',input:{operation_id:this.id(),expected_revision:before.revision,language:changes.language??before.language,clock_24h:changes.clock_24h??before.clock_24h,push_enabled:changes.push_enabled??before.push_enabled,push_mentions_only:changes.push_mentions_only??before.push_mentions_only,desktop_notifications:changes.desktop_notifications??before.desktop_notifications??'default'}});
  }
  async resumeProfile(slot:ProfileSlot):Promise<import('./protocol.generated.ts').OwnProfile> {
    this.ready();const saved=await this.store.profileOperations.get(slot);
    if(!saved||saved.phase==='failed')throw new NativeError(409,'profile_action_pending');
    if(saved.phase==='proof')await this.store.profileOperations.mark(saved,'pending',null);
    try{return await this.applyProfileOperation({...saved,phase:'pending'});}catch(error){await this.profileOperationFailed(saved,error);throw error;}
  }
  async discardProfile(slot:ProfileSlot,id:string):Promise<boolean> {this.ready();const result=await this.store.profileOperations.discard(slot,id);this.notify();return result;}
  private async applyProfileOperation(saved:SavedProfileOperation):Promise<import('./protocol.generated.ts').OwnProfile> {
    const operation=this.commands.then(async()=>{
      this.ready();const generation=this.generation;
      checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
      const current=await this.store.profileOperations.get(saved.command.kind);
      if(!current||current.phase!=='pending'||current.command.input.operation_id!==saved.command.input.operation_id)return this.ownProfile();
      if(!this.capabilities?.profiles||saved.command.kind==='avatar'&&!this.capabilities.profile_avatars)throw new NativeError(501,'unsupported_feature');
      const command=saved.command;
      const receipt=command.kind==='profile'?await this.transport.updateProfile(command.input):command.kind==='preferences'?await this.transport.updatePreferences(command.input):await this.transport.setAvatar(command.input,command.upload?{mime:command.upload.mime,bytes:avatarOctets(command.upload.base64)}:undefined);
      this.roomOperationGeneration(generation);
      const own=await this.ownProfile();this.roomOperationGeneration(generation);
      await this.store.profileOperations.confirm(saved,receipt,()=>generation===this.generation&&!this.stopped);
      this.retryAttempt=0;this.retryAt=0;this.notify();return own;
    });
    this.commands=operation.then(()=>{},()=>{});return operation;
  }
  private async profileOperationFailed(saved:SavedProfileOperation,error:unknown):Promise<void> {
    if(this.stopped||!this.verified)return;
    if(error instanceof NativeError&&['session_rejected','server_identity_changed'].includes(error.code)){this.status={online:false,error:error.code};this.stop();}
    else if(error instanceof NativeError&&error.code==='reauthentication_required')await this.store.profileOperations.mark(saved,'proof',error.code);
    else if(permanentCommandError(error))await this.store.profileOperations.mark(saved,'failed',(error as NativeError).code);
    else this.deferSend(error);
    this.notify();
  }
  async profile(cible:{uid?:string;username?:string}):Promise<import('./protocol.generated.ts').UserProfile> {
    const operation=this.profileReads.then(async()=>{
      this.ready();
      if(!this.capabilities?.profiles)throw new NativeError(501,'unsupported_feature');
      if(!cible.uid && !cible.username)throw new NativeError(422,'invalid_profile');
      const target=cible.uid??null,version=this.profileVersionFor(target),generation=this.generation;
      const guard=()=>{this.roomOperationGeneration(generation);if(version!==this.profileVersionFor(target))throw new NativeError(409,'delivery_revalidate');};
      checkIdentity(this.session,await this.transport.discover());guard();
      const profile=cible.uid?await this.transport.userProfile(cible.uid):await this.transport.lookupProfile(cible.username!);
      checkIdentity(this.session,await this.transport.discover());guard();
      if(cible.uid && profile.user.id!==cible.uid || !cible.uid && profile.user.username!==cible.username)throw new NativeError(0,'invalid_profile');
      await this.store.profileIdentities([profile],()=>version===this.profileVersionFor(target) && !this.stopped);
      guard();return profile;
    });
    this.profileReads=operation.then(()=>{},()=>{});return operation;
  }
  async profileAvatar(id:string):Promise<Uint8Array> {
    this.ready();
    if(!this.capabilities?.profile_avatars)throw new NativeError(501,'unsupported_feature');
    if(!/^[0-9a-f]{64}$/.test(id))throw new NativeError(422,'invalid_avatar');
    const projection=this.store.projectionToken(),generation=this.generation;
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    const bytes=await this.transport.avatarBytes(id);
    checkIdentity(this.session,await this.transport.discover());this.roomOperationGeneration(generation);
    if(projection!==this.store.projectionToken())throw new NativeError(409,'delivery_revalidate');
    return bytes;
  }
  async searchMessages(rid:string,q:string,before?:string):Promise<import('./protocol.generated.ts').Message[]> {
    if(!this.capabilities?.search)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,projection=this.store.projectionToken(),version=this.searchVersion;
    this.roomOperationGeneration(generation);
    const membership=(await this.store.readState(rid))?.membership_version;
    if(!membership)throw new NativeError(409,'delivery_revalidate');
    const page=await this.transport.searchMessages(rid,q,before);
    await this.stateGeneration(generation,projection,rid,membership);
    if(version!==this.searchVersion || page.membership_version!==membership)throw new NativeError(409,'delivery_revalidate');
    if(page.messages.length>50 || page.has_more && !page.messages.length)throw new NativeError(0,'invalid_search_page');
    const ids=new Set<string>();let previous=before===undefined?null:BigInt(before);
    for(const message of page.messages){
      const position=BigInt(message.position);
      if(message.room_id!==rid || message.deleted || message.system!=null || ids.has(message.id) || position<=0n || position.toString()!==message.position || previous!==null && position>=previous)throw new NativeError(0,'invalid_search_page');
      ids.add(message.id);previous=position;
    }
    // Search hits never enlarge the history window or acknowledge a cursor.
    return page.messages;
  }
  async marked(rid:string,starred:boolean):Promise<import('./protocol.generated.ts').Message[]> {
    this.ready();
    if (!(starred?this.capabilities?.stars:this.capabilities?.pins)) throw new NativeError(501,'unsupported_feature');
    const generation=this.generation;
    const token=this.store.projectionToken();
    const messages:import('./protocol.generated.ts').Message[]=[];
    let before:string|undefined;
    for (let pageIndex=0;pageIndex<100;pageIndex++) {
      const page=await this.transport.marked(rid,starred,before);
      if (this.stopped || this.generation!==generation) throw new NativeError(0,'session_closed');
      if (page.messages.length>100 || page.messages.some(m=>m.room_id!==rid || m.deleted || (starred?!m.personal_star?.present:!m.pinned))) throw new NativeError(502,'invalid_message_page');
      let previous=before===undefined?null:BigInt(before);
      for (const message of page.messages) {
        if (!/^(0|[1-9]\d*)$/.test(message.position)) throw new NativeError(502,'invalid_message_page');
        const position=BigInt(message.position);
        if (previous!==null && position>=previous) throw new NativeError(502,'invalid_message_page');
        previous=position;
      }
      const next=page.messages.at(-1)?.position;
      if (page.has_more && (!next || (before!==undefined && BigInt(next)>=BigInt(before)))) throw new NativeError(502,'invalid_message_page');
      messages.push(...page.messages);
      if (!page.has_more) {
        if (!await this.store.ingest(messages,token)) throw new NativeError(409,'delivery_revalidate');
        this.notify(); return messages;
      }
      before=next;
    }
    throw new NativeError(422,'message_list_limit');
  }
  private async submitCommand(rid: string,id: string,revision: string,kind: NativeCommand['kind'],text: string): Promise<void> {
    this.ready();
    const command=await this.store.command(rid,id,revision,kind,text,this.id);
    if (!command) throw new NativeError(409,await this.store.hasCommandRevisionConflict(id)?'revision_conflict':'message_action_pending');
    try { await this.applyCommand(command); }
    catch (error) { await this.commandFailed(command,error); throw error; }
  }
  private async applyCommand(command: NativeCommand): Promise<void> {
    const operation=this.commands.then(async () => {
      this.ready();
      const supported=command.kind==='edit'?this.capabilities?.editing:command.kind==='delete'?this.capabilities?.deletion:command.kind==='pin'?this.capabilities?.pins:command.kind==='star'?this.capabilities?.stars:this.capabilities?.reactions;
      if (!supported) throw new NativeError(501,'unsupported_feature');
      if(command.kind==='edit' && command.quotes===null)throw new NativeError(422,'edit_intent_upgrade_required');
      const generation=this.generation;
      const projection=this.store.projectionToken();
      const input={operation_id:command.id,expected_revision:command.expected_revision};
      const reaction=command.kind==='react'?reactionIntent(command.text):null;
      const mark=command.kind==='pin' || command.kind==='star'?markIntent(command.text):null;
      const message=mark!==null
        ? await this.transport.setMark(command.message_id,{operation_id:command.id,present:mark},command.kind==='star')
        : reaction
        ? await this.transport.setReaction(command.message_id,{operation_id:command.id,...reaction})
        : command.kind==='edit'
        ? await this.transport.editMessage(command.message_id,{...input,content:{kind:'plain',markdown:command.text,mentions:[],quotes:command.quotes??[],files:[]}})
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
  async send(rid: string, text: string,scope?:{membership:string|null},quotes:readonly import('./quotes.ts').NativeQuoteSelection[]=[],replyTo?:string|null): Promise<string> {
    if (this.stopped) throw new NativeError(0,'session_closed');
    const value = text.trim();
    let bytes = 0;
    for (const char of value) { const code = char.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
    if (!value && quotes.length===0 || bytes > 32_768) throw new NativeError(400,'invalid_message');
    const id = this.id();
    await this.store.enqueue(id,rid,value,scope,quotes,replyTo); this.notify();
    if (this.verified) await this.flush();
    return id;
  }
  async markObservedRead(room:string,message:string,membership?:string):Promise<void> {
    this.stateStagingSupported(false);
    if(await this.store.stageRead(room,message,membership))await this.flushStateIntents();
  }
  async markObservedThreadRead(root:string,message:string,membership:string):Promise<void>{
    this.stateStagingSupported(false);
    if(!this.capabilities?.threads)throw new NativeError(501,'unsupported_feature');
    if(await this.store.stageThreadRead(root,message,membership))await this.flushStateIntents();
  }
  async setFavorite(room:string,present:boolean,observed?:{membership:string;revision:string}):Promise<void> {
    this.stateStagingSupported(true);
    if(!await this.store.stageFavorite(room,present,this.id,observed))throw new NativeError(409,observed?'favorite_state_changed':'favorite_action_pending');
    this.notify();await this.flushStateIntents();
  }
  async resumeFavorite(room:string,key?:string):Promise<void> {
    this.stateStagingSupported(true);const saved=await this.store.favoriteIntent(room);
    if(!saved)throw new NativeError(409,'favorite_action_missing');
    if(key && saved.input.operation_id!==key)throw new NativeError(409,'favorite_action_missing');
    if(saved.phase==='failed')throw new NativeError(409,'favorite_action_failed');
    await this.flushStateIntents();
  }
  async dismissFailedFavorite(room:string,id:string):Promise<boolean> {
    if(this.stopped)throw new NativeError(0,'session_closed');
    const dismissed=await this.store.dismissFailedFavorite(room,id);this.notify();return dismissed;
  }
  private stateStagingSupported(favorite:boolean):void {
    if(this.stopped)throw new NativeError(0,'session_closed');
    if(!(favorite?this.capabilities?.favorites:this.capabilities?.read_markers))throw new NativeError(501,'unsupported_feature');
  }
  private async stateGeneration(generation:number,projection:number,room:string,membership:string):Promise<void> {
    this.roomOperationGeneration(generation);
    const current=await this.store.readState(room);
    if(projection!==this.store.projectionToken() || current?.membership_version!==membership)throw new NativeError(409,'delivery_revalidate');
  }
  private deferState(favorite:boolean,error:unknown):void {
    const delay=error instanceof NativeError && error.status===429?Math.min(300,Math.max(1,error.retryAfter??1))*1000:2000;
    if(favorite)this.favoriteRetryAt=Date.now()+delay+Math.random()*250;else this.readRetryAt=Date.now()+delay+Math.random()*250;
  }
  private armStateRetry():void {
    if(this.stateRetryTimer!==null)clearTimeout(this.stateRetryTimer);
    this.stateRetryTimer=null;if(!this.verified || this.stopped)return;
    const deadlines=[this.readRetryAt,this.favoriteRetryAt].filter(t=>t>0);if(!deadlines.length)return;
    this.stateRetryTimer=setTimeout(()=>{this.stateRetryTimer=null;void this.flushStateIntents();},Math.max(1,Math.min(...deadlines)-Date.now()));
  }
  async flushStateIntents():Promise<void> {
    if(this.stateFlushing)return this.stateFlushing;
    if(!this.verified || this.stopped)return;
    this.stateFlushing=this.flushStateOnce().catch(error=>{
      if(error instanceof NativeError && ['session_rejected','server_identity_changed'].includes(error.code)){this.status={online:false,error:error.code};this.stop();}
      else if(this.verified && !this.stopped){this.deferState(false,error);this.deferState(true,error);}
    }).finally(()=>{this.stateFlushing=null;this.armStateRetry();});
    return this.stateFlushing;
  }
  private async flushStateOnce():Promise<void> {
    if(Date.now()>=this.favoriteRetryAt){
      this.favoriteRetryAt=0;
      for(const saved of await this.store.pendingFavorites()){
        try{await this.applyFavorite(saved);}
        catch(error){
          if(error instanceof NativeError && ['session_rejected','server_identity_changed'].includes(error.code))throw error;
          if(this.stopped || !this.verified)return;
          if(saved.phase==='pending' && permanentRoomError(error) && !(error instanceof NativeError && error.code==='invalid_favorite_receipt')){await this.store.failFavorite(saved.room,saved.input.operation_id,(error as NativeError).code);this.notify();}
          else{this.deferState(true,error);break;}
        }
      }
      if(!this.favoriteRetryAt && (await this.store.pendingFavorites()).length)this.favoriteRetryAt=Date.now()+2000;
    }
    if(Date.now()>=this.readRetryAt){
      this.readRetryAt=0;
      for(const saved of await this.store.pendingReads()){
        try{await this.applyObservedRead(saved);}
        catch(error){
          if(error instanceof NativeError && ['session_rejected','server_identity_changed'].includes(error.code))throw error;
          if(this.stopped || !this.verified)return;
          this.deferState(false,error);break;
        }
      }
      if(!this.readRetryAt){
        for(const saved of await this.store.pendingThreadReads()){
          try{await this.applyObservedThreadRead(saved);}
          catch(error){
            if(error instanceof NativeError && ['session_rejected','server_identity_changed'].includes(error.code))throw error;
            if(this.stopped || !this.verified)return;
            this.deferState(false,error);break;
          }
        }
      }
      if(!this.readRetryAt && ((await this.store.pendingReads()).length || (await this.store.pendingThreadReads()).length))this.readRetryAt=Date.now()+100;
    }
  }
  private async applyObservedRead(saved:PendingRead):Promise<void> {
    const generation=this.generation,projection=this.store.projectionToken();
    await this.stateGeneration(generation,projection,saved.room,saved.membership);
    checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.room,saved.membership);
    if(!this.capabilities?.read_markers)throw new NativeError(501,'unsupported_feature');
    const current=await this.transport.roomReadState(saved.room);
    checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.room,saved.membership);
    if(current.room_id!==saved.room)throw new NativeError(409,'invalid_read_state');
    if(!await this.store.cacheReadState(current,projection))throw new NativeError(409,'delivery_revalidate');
    this.notify();
    const known=await this.store.readState(saved.room);
    if(known && BigInt(known.root_position)>=BigInt(saved.root_position))return;
    await this.stateGeneration(generation,projection,saved.room,saved.membership);
    const confirmed=await this.transport.markRoomRead(saved.room,{root_position:saved.root_position,reply_position:'0'});
    checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.room,saved.membership);
    if(confirmed.room_id!==saved.room)throw new NativeError(409,'invalid_read_state');
    if(!await this.store.cacheReadState(confirmed,projection))throw new NativeError(409,'delivery_revalidate');
    this.notify();
  }
  private async applyObservedThreadRead(saved:import('./threads.ts').PendingThreadRead):Promise<void>{
    const generation=this.generation,projection=this.store.projectionToken();
    await this.stateGeneration(generation,projection,saved.rid,saved.membership);
    checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.rid,saved.membership);
    if(!this.capabilities?.threads)throw new NativeError(501,'unsupported_feature');
    const confirmed=await this.transport.markThreadRead(saved.root,saved.position);
    checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.rid,saved.membership);
    if(confirmed.root_id!==saved.root || confirmed.room_id!==saved.rid || confirmed.membership_version!==saved.membership || BigInt(confirmed.position)<BigInt(saved.position))throw new NativeError(409,'invalid_read_state');
    if(!await this.store.completeThreadRead(confirmed,projection))throw new NativeError(409,'delivery_revalidate');
    const room=await this.transport.roomReadState(saved.rid);
    await this.stateGeneration(generation,projection,saved.rid,saved.membership);
    if(!await this.store.cacheReadState(room,projection))throw new NativeError(409,'delivery_revalidate');
    this.notify();
  }
  private applyFavorite(saved:SavedFavorite):Promise<void> {
    const operation=this.commands.then(async()=>{
      const generation=this.generation,projection=this.store.projectionToken();
      const live=async()=>{const current=await this.store.favoriteIntent(saved.room);return current?.phase!=='failed' && current?.input.operation_id===saved.input.operation_id;};
      await this.stateGeneration(generation,projection,saved.room,saved.membership);if(!await live())return;
      const discovery=await this.transport.discover();checkIdentity(this.session,discovery);this.capabilities=discovery.capabilities;
      await this.stateGeneration(generation,projection,saved.room,saved.membership);
      if(saved.phase==='pending'){
        let receipt:import('./protocol.generated.ts').RoomCommandReceipt;
        try{receipt=await this.transport.roomCommandReceipt(saved.room,saved.input.operation_id);}
        catch(error){
          if(!(error instanceof NativeError) || error.status!==404 || error.code!=='not_found')throw error;
          await this.stateGeneration(generation,projection,saved.room,saved.membership);if(!await live())return;
          if(!this.capabilities?.favorites)throw new NativeError(501,'unsupported_feature');
          receipt=await this.transport.setRoomFavorite(saved.room,saved.input);
        }
        checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.room,saved.membership);
        if(receipt.room_id!==saved.room || receipt.operation_id!==saved.input.operation_id)throw new NativeError(409,'invalid_favorite_receipt');
        if(!await this.store.confirmFavoriteReceipt(receipt,projection))return;
        this.notify();
      }
      const current=await this.transport.roomReadState(saved.room);
      checkIdentity(this.session,await this.transport.discover());await this.stateGeneration(generation,projection,saved.room,saved.membership);
      if(current.room_id!==saved.room)throw new NativeError(409,'invalid_read_state');
      if(!await this.store.cacheReadState(current,projection))throw new NativeError(409,'delivery_revalidate');
      this.notify();
    });
    this.commands=operation.catch(()=>{});return operation;
  }
  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; return this.flush(); }
    if (!this.verified || this.stopped) return;
    const state=this.flushStateIntents();
    if (Date.now()<this.retryAt) { this.armRetry(); await state; return; }
    this.flushing = this.flushOnce().catch(error => {
      if (this.verified && !this.stopped) this.deferSend(error);
    }).finally(() => { this.flushing = null; });
    await Promise.all([this.flushing,state]);
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
        const message = await this.transport.send(pending.rid,{operation_id:pending.id,text:pending.texte,quotes:pending.quotes,...(pending.reply_to?{reply_to:pending.reply_to}:{})});
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
    for(const saved of await this.store.pendingRoomOperations()){
      if(!this.verified || this.stopped)return;
      try{await this.applyRoomOperation(saved);}
      catch(error){await this.roomOperationFailed(saved,error);if(!permanentRoomError(error))return;}
    }
    for(const saved of await this.store.profileOperations.pending()){
      try{await this.applyProfileOperation(saved);}catch(error){await this.profileOperationFailed(saved,error);if(!permanentCommandError(error))return;}
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
  async loadThread(root:string,abandoned:()=>boolean=()=>false):Promise<void>{
    this.ready();
    if(!this.capabilities?.threads)throw new NativeError(501,'unsupported_feature');
    const generation=this.generation,projection=this.store.projectionToken();
    let before:string|undefined;
    for(let index=0;index<1000;index++){
      if(abandoned())return;
      const page=await this.transport.thread(root,before);
      if(abandoned())return;
      if(this.stopped || generation!==this.generation)throw new NativeError(0,'session_closed');
      if(page.root.id!==root)throw new NativeError(409,'invalid_thread_page');
      let previous=before===undefined?null:BigInt(before);
      for(const message of page.messages){
        const position=BigInt(message.position);
        if(position<=0n || previous!==null && position>=previous)throw new NativeError(409,'invalid_thread_page');
        previous=position;
      }
      if(page.has_more && !page.messages.length)throw new NativeError(409,'invalid_thread_page');
      if(!await this.store.cacheThread(page,projection))throw new NativeError(409,'delivery_revalidate');
      this.notify();
      if(!page.has_more)return;
      before=page.messages.at(-1)!.position;
    }
    throw new NativeError(409,'thread_limit');
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
  async direct(username: string,uid?:string): Promise<string> {
    this.ready();
    const generation = this.generation;
    const user = uid&&this.capabilities?.profiles?(await this.profile({uid})).user:(await this.transport.users()).find(user => uid?user.id===uid:user.username===username.trim());
    if (!user) throw new NativeError(404,'user_not_found');
    this.roomOperationGeneration(generation);
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

function permanentRoomError(error:unknown):boolean {
  return permanentCommandError(error) && !(error instanceof NativeError && ['invalid_room_receipt','server_identity_changed'].includes(error.code));
}

function reactionIntent(text:string):{emoji:string;present:boolean} {
  try {
    const value=JSON.parse(text);
    if (value && typeof value.emoji==='string' && typeof value.present==='boolean' && Object.keys(value).length===2 && canonicalEmoji(value.emoji)) return value;
  } catch { /* Invalid persisted input is quarantined, never retried in a loop. */ }
  throw new NativeError(422,'invalid_message_action');
}

function markIntent(text:string):boolean {
  try {const value=JSON.parse(text);if (typeof value==='boolean') return value;} catch { /* Reject corrupt persisted input. */ }
  throw new NativeError(422,'invalid_message_action');
}

function utf8RoomBytes(value: string): number {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./g,'x').length;
}
