/** Native HTTP transport shared by the mobile pilot and integration tests. */
import type { CreateRoom, Discovery, DirectMessage, Message, MessagePage, NativeTypes, Room, SendMessage, Session, Snapshot, SocketTicket, SyncBatch } from './protocol.generated.ts';
import { decodeNative } from './validation.ts';

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) { const code = char.codePointAt(0)!; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}

export class NativeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, retryAfter?: number, requestId?: string) {
    super(code);
    this.name = 'NativeError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
  }
}

export class NativeTransport {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private token: string | null = null;
  private snapshotPaging: boolean | null = null;
  private readonly cooldowns = new Map<string, {until:number; code:string;requestId:string}>();
  surJetonRefuse: ((token: string) => void) | null = null;

  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid server URL');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetcher = fetcher;
  }

  private async value(path: string, input?: unknown, anonymous = false, signal?: AbortSignal, method?: string): Promise<unknown> {
    if (!anonymous && this.token === null) throw new NativeError(401, 'session_rejected');
    const sent = anonymous ? null : this.token;
    const verb=method??(input===undefined?'GET':'POST');
    const budget = ['/api/v1/auth/login','/api/v1/auth/start','/api/v1/auth/factors/verify','/api/v1/auth/invitations/accept','/api/v1/auth/recovery','/api/v1/me/reauth/start','/api/v1/me/reauth/finish'].includes(path) ? 'login' : ['/api/v1/me/email/verification/start','/api/v1/auth/factors/email/start','/api/v1/me/reauth/email/start'].includes(path) ? 'email_delivery' : path === '/api/v1/auth/recovery/email/start' ? 'email_recovery' : path === '/api/v1/auth/renew' ? 'session_rotation' : path === '/api/v1/sync/ticket' ? 'ticket' : path === '/api/v1/sync/snapshots' ? 'snapshot' : path.startsWith('/api/v1/messages/') && ['PATCH','DELETE','PUT'].includes(verb)?'message_action':path.startsWith('/api/v1/rooms/') && verb==='POST' && path.endsWith('/read')?'room_read':path.startsWith('/api/v1/rooms/') && (verb==='PATCH' || verb==='PUT' && (path.endsWith('/role') || path.endsWith('/favorite')) || verb==='POST' && path.endsWith('/leave'))?'room_command':null;
    const cooldown = budget === null ? undefined : this.cooldowns.get(budget);
    if (cooldown && cooldown.until > Date.now()) throw new NativeError(429,cooldown.code,Math.ceil((cooldown.until-Date.now())/1000),cooldown.requestId);
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay);
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: verb,
      headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(anonymous ? {} : { authorization: `Bearer ${this.token}` }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = decodeNative('ApiError', await response.json());
      if (response.status === 401 && error.code === 'session_rejected' && sent !== null) this.surJetonRefuse?.(sent);
      const header = response.headers.get('retry-after');
      const retry = Math.min(300,Math.max(1,header && /^\d+$/.test(header) ? Number(header) : 1));
      if (response.status === 429 && budget !== null) this.cooldowns.set(budget,{until:Date.now()+retry*1000,code:error.code,requestId:error.request_id});
      throw new NativeError(response.status, error.code, response.status === 429 ? retry : undefined, error.request_id);
    }
      if (path === '/api/v1/sync/snapshots' || path.startsWith('/api/v1/sync/snapshots/')) {
        const length = response.headers.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length)>1024*1024) {
          controller.abort();
          throw new NativeError(0,'invalid_snapshot');
        }
        // React Native fetch buffers the response; check its actual UTF-8 body
        // before JSON parsing too, even when no length header was supplied.
        const text = await response.text();
        if (utf8Bytes(text)>1024*1024) throw new NativeError(0,'invalid_snapshot');
        return JSON.parse(text);
      }
      return response.status === 204 ? undefined : await response.json();
    } catch (error) {
      if (error instanceof NativeError) throw error;
      if (signal?.aborted) throw error;
      // A malformed success/error is not proof that a stored token was revoked.
      throw new NativeError(0, 'network_or_protocol_error');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    }
  }

  private async request<K extends keyof NativeTypes>(name: K, path: string, input?: unknown, anonymous = false, signal?: AbortSignal, method?: string): Promise<NativeTypes[K]> {
    return decodeNative(name, await this.value(path, input, anonymous, signal, method));
  }

  async discover(signal?: AbortSignal): Promise<Discovery> {
    const discovery = await this.request('Discovery', '/.well-known/rocketvibe', undefined, true, signal);
    if (discovery.product !== 'rocketvibe' || !discovery.protocol_versions.includes(1) || discovery.api_path !== '/api/v1') throw new Error('Unsupported RocketVibe protocol');
    this.snapshotPaging = discovery.capabilities.snapshot_paging === true;
    return discovery;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.request('Session', '/api/v1/auth/login', { username, password }, true);
    this.token = session.token;
    return session;
  }

  restore(token: string): void { this.token = token; }
  // These anonymous steps never replace or revoke an already active account.
  // Persist the candidate in secure storage before finishFactor, then pin the
  // response identity before installing the completed session.
  startLogin(username:string,password:string):Promise<NativeTypes['AuthenticationStep']> {
    return this.request('AuthenticationStep','/api/v1/auth/start',{username,password},true);
  }
  finishFactor(input:NativeTypes['FinishFactor']):Promise<Session> {
    return this.request('Session','/api/v1/auth/factors/verify',input,true);
  }
  factorStatus():Promise<NativeTypes['FactorStatus']> { return this.request('FactorStatus','/api/v1/me/factors'); }
  enableEmailFactor(input:NativeTypes['ChangeEmailFactor']):Promise<NativeTypes['EmailFactorChange']> { return this.request('EmailFactorChange','/api/v1/me/factors/email/enable',input); }
  disableEmailFactor(input:NativeTypes['ChangeEmailFactor']):Promise<NativeTypes['EmailFactorChange']> { return this.request('EmailFactorChange','/api/v1/me/factors/email/disable',input); }
  beginFactorEmail(input:NativeTypes['RequestFactorEmail']):Promise<NativeTypes['FactorEmailDelivery']> { return this.request('FactorEmailDelivery','/api/v1/auth/factors/email/start',input,true); }
  resumeFactorEmail(input:NativeTypes['RequestFactorEmail']):Promise<NativeTypes['FactorEmailDelivery']> { return this.request('FactorEmailDelivery','/api/v1/auth/factors/email/resume',input,true); }
  beginReauthenticationEmail(input:NativeTypes['RequestFactorEmail']):Promise<NativeTypes['FactorEmailDelivery']> { return this.request('FactorEmailDelivery','/api/v1/me/reauth/email/start',input); }
  resumeReauthenticationEmail(input:NativeTypes['RequestFactorEmail']):Promise<NativeTypes['FactorEmailDelivery']> { return this.request('FactorEmailDelivery','/api/v1/me/reauth/email/resume',input); }
  emailStatus():Promise<NativeTypes['EmailStatus']> { return this.request('EmailStatus','/api/v1/me/email'); }
  beginEmailVerification(input:NativeTypes['BeginEmailVerification']):Promise<NativeTypes['EmailVerificationStep']> { return this.request('EmailVerificationStep','/api/v1/me/email/verification/start',input); }
  removeVerifiedEmail(input:NativeTypes['RemoveVerifiedEmail']):Promise<NativeTypes['EmailRemovalReceipt']> { return this.request('EmailRemovalReceipt','/api/v1/me/email/removal/start',input); }
  resumeEmailRemoval(input:NativeTypes['ResumeEmailRemoval']):Promise<NativeTypes['EmailRemovalReceipt']> { return this.request('EmailRemovalReceipt','/api/v1/me/email/removal/resume',input); }
  retireEmailRemoval(input:NativeTypes['RetireEmailRemoval']):Promise<NativeTypes['EmailStatus']> { return this.request('EmailStatus','/api/v1/me/email/removal/retire',input); }
  resumeEmailVerification(input:NativeTypes['ResumeEmailVerification']):Promise<NativeTypes['EmailVerificationStep']> { return this.request('EmailVerificationStep','/api/v1/me/email/verification/resume',input); }
  confirmEmailVerification(input:NativeTypes['ConfirmEmailVerification']):Promise<NativeTypes['EmailVerificationStep']> { return this.request('EmailVerificationStep','/api/v1/me/email/verification/confirm',input); }
  retireEmailVerification(input:NativeTypes['RetireEmailVerification']):Promise<NativeTypes['EmailStatus']> { return this.request('EmailStatus','/api/v1/me/email/verification/retire',input); }
  beginFactorSetup(input:NativeTypes['BeginFactorSetup']):Promise<NativeTypes['FactorSetup']> { return this.request('FactorSetup','/api/v1/me/factors/totp/setup',input); }
  enableFactor(input:NativeTypes['EnableFactor']):Promise<NativeTypes['FactorBackupCodes']> { return this.request('FactorBackupCodes','/api/v1/me/factors/totp/enable',input); }
  async disableFactor(input:NativeTypes['DisableFactor']):Promise<void> { await this.value('/api/v1/me/factors/totp/disable',input); }
  regenerateFactorBackups(input:NativeTypes['RegenerateFactorBackups']):Promise<NativeTypes['FactorBackupCodes']> { return this.request('FactorBackupCodes','/api/v1/me/factors/recovery/regenerate',input); }
  beginReauthentication(input:NativeTypes['BeginReauthentication']):Promise<NativeTypes['ReauthenticationStep']> { return this.request('ReauthenticationStep','/api/v1/me/reauth/start',input); }
  reauthenticationStatus():Promise<NativeTypes['ReauthenticationStatus']> { return this.request('ReauthenticationStatus','/api/v1/me/reauth'); }
  finishReauthentication(input:NativeTypes['FinishReauthentication']):Promise<NativeTypes['ReauthenticationGrant']> { return this.request('ReauthenticationGrant','/api/v1/me/reauth/finish',input); }
  resumeReauthentication(input:NativeTypes['ResumeReauthentication']):Promise<NativeTypes['ReauthenticationStep']> { return this.request('ReauthenticationStep','/api/v1/me/reauth/resume',input); }
  retireReauthentication(input:NativeTypes['RetireReauthentication']):Promise<NativeTypes['ReauthenticationStatus']> { return this.request('ReauthenticationStatus','/api/v1/me/reauth/retire',input); }
  acceptInvitation(input: NativeTypes['AcceptInvitation']):Promise<NativeTypes['User']> {
    return this.request('User','/api/v1/auth/invitations/accept',input,true);
  }
  recoverAccount(input: NativeTypes['RecoverAccount']):Promise<NativeTypes['User']> {
    return this.request('User','/api/v1/auth/recovery',input,true);
  }
  requestEmailRecovery(input:NativeTypes['RequestEmailRecovery']):Promise<NativeTypes['EmailRecoveryRequested']> {
    return this.request('EmailRecoveryRequested','/api/v1/auth/recovery/email/start',input,true);
  }
  renew(input:NativeTypes['RenewSession']):Promise<Session> { return this.request('Session','/api/v1/auth/renew',input); }
  async deviceSessions():Promise<NativeTypes['DeviceSession'][]> {
    const devices=await this.value('/api/v1/me/sessions');
    if (!Array.isArray(devices) || devices.length>64) throw new Error('Invalid native devices');
    return devices.map(device=>decodeNative('DeviceSession',device));
  }
  async renameDevice(id:string,label:string):Promise<void> { await this.value(`/api/v1/me/sessions/${encodeURIComponent(id)}`,{label},false,undefined,'PATCH'); }
  async revokeDevice(id:string):Promise<void> { await this.value(`/api/v1/me/sessions/${encodeURIComponent(id)}`,undefined,false,undefined,'DELETE'); }
  async logout(): Promise<void> { try { await this.value('/api/v1/auth/logout', {}); } finally { this.token = null; } }
  me(): Promise<NativeTypes['User']> { return this.request('User', '/api/v1/me'); }
  accountPermissions(): Promise<NativeTypes['AccountPermissions']> { return this.request('AccountPermissions','/api/v1/me/permissions'); }
  roomPermissions(room: string): Promise<NativeTypes['RoomPermissions']> { return this.request('RoomPermissions',`/api/v1/rooms/${encodeURIComponent(room)}/permissions`); }
  roomDetails(room:string):Promise<NativeTypes['RoomDetails']> { return this.request('RoomDetails',`/api/v1/rooms/${encodeURIComponent(room)}`); }
  roomMembers(room:string,after?:string,revision?:string):Promise<NativeTypes['RoomMemberPage']> {
    return this.request('RoomMemberPage',`/api/v1/rooms/${encodeURIComponent(room)}/members?${after?`after=${encodeURIComponent(after)}&`:''}${revision?`revision=${encodeURIComponent(revision)}`:''}`);
  }
  updateRoom(room:string,input:NativeTypes['UpdateRoom']):Promise<NativeTypes['RoomCommandReceipt']> { return this.request('RoomCommandReceipt',`/api/v1/rooms/${encodeURIComponent(room)}`,input,false,undefined,'PATCH'); }
  changeRoomRole(room:string,user:string,input:NativeTypes['ChangeRoomRole']):Promise<NativeTypes['RoomCommandReceipt']> { return this.request('RoomCommandReceipt',`/api/v1/rooms/${encodeURIComponent(room)}/members/${encodeURIComponent(user)}/role`,input,false,undefined,'PUT'); }
  leaveRoom(room:string,input:NativeTypes['LeaveRoom']):Promise<NativeTypes['RoomCommandReceipt']> { return this.request('RoomCommandReceipt',`/api/v1/rooms/${encodeURIComponent(room)}/leave`,input); }
  roomCommandReceipt(room:string,operation:string):Promise<NativeTypes['RoomCommandReceipt']> { return this.request('RoomCommandReceipt',`/api/v1/rooms/${encodeURIComponent(room)}/commands/${encodeURIComponent(operation)}`); }
  roomReadState(room:string):Promise<NativeTypes['ReadState']> { return this.request('ReadState',`/api/v1/rooms/${encodeURIComponent(room)}/read`); }
  markRoomRead(room:string,input:NativeTypes['MarkRead']):Promise<NativeTypes['ReadState']> { return this.request('ReadState',`/api/v1/rooms/${encodeURIComponent(room)}/read`,input); }
  setRoomFavorite(room:string,input:NativeTypes['SetRoomFavorite']):Promise<NativeTypes['RoomCommandReceipt']> { return this.request('RoomCommandReceipt',`/api/v1/rooms/${encodeURIComponent(room)}/favorite`,input,false,undefined,'PUT'); }
  messagePermissions(message: string): Promise<NativeTypes['MessagePermissions']> { return this.request('MessagePermissions',`/api/v1/messages/${encodeURIComponent(message)}/permissions`); }
  message(id: string): Promise<Message> { return this.request('Message',`/api/v1/messages/${encodeURIComponent(id)}`); }
  editMessage(id: string,input: NativeTypes['EditMessage']): Promise<Message> { return this.request('Message',`/api/v1/messages/${encodeURIComponent(id)}`,input,false,undefined,'PATCH'); }
  deleteMessage(id: string,input: NativeTypes['DeleteMessage']): Promise<Message> { return this.request('Message',`/api/v1/messages/${encodeURIComponent(id)}`,input,false,undefined,'DELETE'); }
  setReaction(id: string,input: NativeTypes['SetReaction']): Promise<Message> { return this.request('Message',`/api/v1/messages/${encodeURIComponent(id)}/reactions`,input,false,undefined,'PUT'); }
  setMark(id:string,input:NativeTypes['SetMark'],starred:boolean):Promise<Message> {
    return this.request('Message',`/api/v1/messages/${encodeURIComponent(id)}/${starred?'star':'pin'}`,input,false,undefined,'PUT');
  }
  marked(room:string,starred:boolean,before?:string):Promise<MessagePage> {
    return this.request('MessagePage',`/api/v1/rooms/${encodeURIComponent(room)}/${starred?'stars':'pins'}?limit=100${before?`&before=${encodeURIComponent(before)}`:''}`);
  }
  async users(): Promise<NativeTypes['User'][]> {
    const users = await this.value('/api/v1/users');
    if (!Array.isArray(users)) throw new Error('Invalid native directory');
    return users.map(user => decodeNative('User', user));
  }
  createRoom(input: CreateRoom): Promise<Room> { return this.request('Room', '/api/v1/rooms', input); }
  publicRooms(query: string, after?: string): Promise<NativeTypes['PublicRoomPage']> {
    return this.request('PublicRoomPage', `/api/v1/rooms/public?q=${encodeURIComponent(query)}${after?`&after=${encodeURIComponent(after)}`:''}`);
  }
  joinPublic(room: string): Promise<Room> { return this.request('Room', `/api/v1/rooms/${encodeURIComponent(room)}/join`, {}); }
  direct(input: DirectMessage): Promise<Room> { return this.request('Room', '/api/v1/direct-messages', input); }
  async addMember(room: string, user: string): Promise<void> { await this.value(`/api/v1/rooms/${encodeURIComponent(room)}/members/${encodeURIComponent(user)}`, {}); }
  send(room: string, input: SendMessage): Promise<Message> { return this.request('Message', `/api/v1/rooms/${encodeURIComponent(room)}/messages`, input); }
  history(room: string, before?: string): Promise<MessagePage> { return this.request('MessagePage', `/api/v1/rooms/${encodeURIComponent(room)}/messages${before === undefined ? '' : '?before=' + encodeURIComponent(before)}`); }
  async snapshot(): Promise<Snapshot> {
    if (this.token === null) throw new NativeError(401,'session_rejected');
    if (this.snapshotPaging === null) await this.discover();
    if (!this.snapshotPaging) return this.request('Snapshot', '/api/v1/sync/snapshot');
    const started = Date.now();
    let page = await this.request('SnapshotPage','/api/v1/sync/snapshots',{});
    const id = page.snapshot_id;
    const snapshot: Snapshot = {protocol_version:1,rooms:[],messages:[],cursor:''};
    const rooms = new Set<string>(), messages = new Set<string>(), tokens = new Set<string>();
    let total = 0;
    const invalid = () => new NativeError(0,'invalid_snapshot');
    for (let index=0;index<128;index++) {
      // Count UTF-8 bytes, including JSON escaping. RN doesn't require TextEncoder.
      const bytes = utf8Bytes(JSON.stringify(page));
      total += bytes;
      if (page.protocol_version !== 1 || page.snapshot_id !== id || !id || page.page_index !== index
        || bytes>1024*1024 || total>64*1024*1024 || Date.now()-started>300_000) throw invalid();
      for (const room of page.rooms) { if (rooms.has(room.id)) throw invalid(); rooms.add(room.id); snapshot.rooms.push(room); }
      for (const message of page.messages) { if (messages.has(message.id)) throw invalid(); messages.add(message.id); snapshot.messages.push(message); }
      if (page.next == null) {
        if (!page.cursor || snapshot.messages.some(m => !rooms.has(m.room_id))) throw invalid();
        snapshot.cursor = page.cursor;
        return snapshot;
      }
      if (page.cursor != null || !page.next || !/^[a-zA-Z0-9_-]{1,128}$/.test(page.next) || tokens.has(page.next)) throw invalid();
      tokens.add(page.next);
      page = await this.request('SnapshotPage',`/api/v1/sync/snapshots/${page.next}`);
    }
    throw invalid();
  }
  changes(cursor: string): Promise<SyncBatch> { return this.request('SyncBatch', `/api/v1/sync/changes?cursor=${encodeURIComponent(cursor)}`); }

  async socketUrl(cursor: string): Promise<string> {
    const ticket: SocketTicket = await this.request('SocketTicket', '/api/v1/sync/ticket', {});
    const url = new URL(`${this.baseUrl}/api/v1/sync/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket.ticket);
    url.searchParams.set('cursor', cursor);
    return url.toString();
  }
}
