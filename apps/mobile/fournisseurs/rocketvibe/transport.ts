/** Native HTTP transport shared by the mobile pilot and integration tests. */
import type { CreateRoom, Discovery, DirectMessage, Message, MessagePage, NativeTypes, Room, SendMessage, Session, Snapshot, SocketTicket, SyncBatch, StartMeeting, JoinMeeting, Meeting, MeetingJoin } from './protocol.generated.ts';
import { decodeNative } from './validation.ts';
import {createHash} from 'crypto';
import {emojiCatalog} from './customEmojis.ts';
import {previewImage} from './linkPreviews.ts';

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
  submitCryptoGroup(room:string,input:NativeTypes['GroupSubmission']):Promise<NativeTypes['GroupReceipt']> {
    return this.request('GroupReceipt',`/api/v1/e2ee/rooms/${encodeURIComponent(room)}/transitions`,input);
  }
  cryptoGroupState(room:string):Promise<NativeTypes['GroupState']> {
    return this.request('GroupState',`/api/v1/e2ee/rooms/${encodeURIComponent(room)}/state`);
  }
  cryptoGroupEvents(room:string,after:string):Promise<NativeTypes['GroupEventPage']> {
    return this.request('GroupEventPage',`/api/v1/e2ee/rooms/${encodeURIComponent(room)}/events?after=${encodeURIComponent(after)}`);
  }
  cryptoGroupOperation(room:string,operation:string):Promise<NativeTypes['GroupReceipt']> {
    return this.request('GroupReceipt',`/api/v1/e2ee/rooms/${encodeURIComponent(room)}/operations/${encodeURIComponent(operation)}`);
  }
  availableCryptoKeyPackage(room:string,user:string,device:string):Promise<NativeTypes['AvailableKeyPackage']> {
    return this.request('AvailableKeyPackage',`/api/v1/e2ee/rooms/${encodeURIComponent(room)}/key-packages/${encodeURIComponent(user)}/${encodeURIComponent(device)}`);
  }
  registerCryptoDevice(input:NativeTypes['RegisterDevice']):Promise<NativeTypes['OperationReceipt']> {
    return this.request('OperationReceipt','/api/v1/e2ee/devices',input);
  }
  publishKeyPackages(input:NativeTypes['PublishKeyPackages']):Promise<NativeTypes['OperationReceipt']> {
    return this.request('OperationReceipt','/api/v1/e2ee/key-packages',input);
  }
  /** Transport only: the Rust engine checks signatures, scope, pins and consent. */
  cryptoDirectory(user:string,after?:string):Promise<NativeTypes['Directory']> {
    return this.request('Directory',`/api/v1/e2ee/users/${encodeURIComponent(user)}${after===undefined?'':`?after=${encodeURIComponent(after)}`}`);
  }
  cryptoOperation(operation:string):Promise<NativeTypes['OperationReceipt']> {
    return this.request('OperationReceipt',`/api/v1/e2ee/operations/${encodeURIComponent(operation)}`);
  }
  async startMeeting(room:string,input:StartMeeting):Promise<Meeting> {
    return this.request('Meeting',`/api/v1/rooms/${encodeURIComponent(room)}/meetings`,input);
  }
  async meeting(id:string):Promise<Meeting> {
    return this.request('Meeting',`/api/v1/meetings/${encodeURIComponent(id)}`);
  }
  async joinMeeting(id:string,input:JoinMeeting):Promise<MeetingJoin> {
    return this.request('MeetingJoin',`/api/v1/meetings/${encodeURIComponent(id)}/join`,input);
  }
  async endMeeting(id:string,input:JoinMeeting):Promise<Meeting> {
    return this.request('Meeting',`/api/v1/meetings/${encodeURIComponent(id)}/end`,input);
  }
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

  private async value(path: string, input?: unknown, anonymous = false, signal?: AbortSignal, method?: string, binary?:{body?:ArrayBuffer;mime?:string;read?:boolean;file?:{bytes:number;mime:string};timeout?:number}): Promise<unknown> {
    if (!anonymous && this.token === null) throw new NativeError(401, 'session_rejected');
    const sent = anonymous ? null : this.token;
    const verb=method??(input===undefined?'GET':'POST');
    const budget = path.endsWith('/messages/search') && verb==='GET' ? 'search' : ['/api/v1/auth/login','/api/v1/auth/start','/api/v1/auth/factors/verify','/api/v1/auth/invitations/accept','/api/v1/auth/recovery','/api/v1/me/reauth/start','/api/v1/me/reauth/finish'].includes(path) ? 'login' : ['/api/v1/me/email/verification/start','/api/v1/auth/factors/email/start','/api/v1/me/reauth/email/start'].includes(path) ? 'email_delivery' : path === '/api/v1/auth/recovery/email/start' ? 'email_recovery' : path === '/api/v1/auth/renew' ? 'session_rotation' : path === '/api/v1/sync/ticket' ? 'ticket' : path === '/api/v1/sync/snapshots' ? 'snapshot' : path.startsWith('/api/v1/messages/') && ['PATCH','DELETE','PUT'].includes(verb)?'message_action':path.startsWith('/api/v1/rooms/') && verb==='POST' && path.endsWith('/read')?'room_read':path.startsWith('/api/v1/rooms/') && (verb==='PATCH' || verb==='PUT' && (path.endsWith('/role') || path.endsWith('/favorite')) || verb==='POST' && path.endsWith('/leave'))?'room_command':null;
    const effectiveBudget = (path==='/api/v1/me' || path==='/api/v1/me/preferences' || path.startsWith('/api/v1/me/avatar?')) && ['PATCH','PUT','DELETE'].includes(verb)?'profile':path.startsWith('/api/v1/e2ee/') && verb==='POST'?'crypto':budget;
    const cooldown = effectiveBudget === null ? undefined : this.cooldowns.get(effectiveBudget);
    if (cooldown && cooldown.until > Date.now()) throw new NativeError(429,cooldown.code,Math.ceil((cooldown.until-Date.now())/1000),cooldown.requestId);
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay);
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), binary?.timeout ?? 15_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: verb,
      headers: { ...(binary?.mime ? {'content-type':binary.mime} : input === undefined ? {} : { 'content-type': 'application/json' }), ...(anonymous ? {} : { authorization: `Bearer ${sent}` }) },
      body: binary?.body ?? (input === undefined ? undefined : JSON.stringify(input)),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = decodeNative('ApiError', await response.json());
      if (response.status === 401 && error.code === 'session_rejected' && sent !== null) this.surJetonRefuse?.(sent);
      const header = response.headers.get('retry-after');
      const retry = Math.min(300,Math.max(1,header && /^\d+$/.test(header) ? Number(header) : 1));
      if (response.status === 429 && effectiveBudget !== null) this.cooldowns.set(effectiveBudget,{until:Date.now()+retry*1000,code:error.code,requestId:error.request_id});
      throw new NativeError(response.status, error.code, response.status === 429 ? retry : undefined, error.request_id);
    }
      if (path === '/api/v1/emoji' || path === '/api/v1/sync/snapshots' || path.startsWith('/api/v1/sync/snapshots/')) {
        const invalid=path==='/api/v1/emoji'?'invalid_emoji_catalog':'invalid_snapshot';
        const length = response.headers.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length)>1024*1024) {
          controller.abort();
          throw new NativeError(0,invalid);
        }
        // React Native fetch buffers the response; check its actual UTF-8 body
        // before JSON parsing too, even when no length header was supplied.
        const text = await response.text();
        if (utf8Bytes(text)>1024*1024) throw new NativeError(0,invalid);
        return JSON.parse(text);
      }
      if(binary?.read || binary?.file){
        const max=binary.file?.bytes ?? 2*1024*1024;
        const mime=binary.file?.mime ?? 'image/png';
        const invalid=binary.file?'invalid_file':'invalid_avatar';
        const length=response.headers.get('content-length');
        if(response.headers.get('content-type')!==mime || length!==null && (!/^\d+$/.test(length) || Number(length)>max))throw new NativeError(502,invalid);
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length>max || binary.file && bytes.length!==max)throw new NativeError(502,invalid);
        return bytes;
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

  registerPush(token:string):Promise<import('./protocol.generated.ts').PushRegistration> {
    return this.request('PushRegistration','/api/v1/me/push',{token},false,undefined,'PUT');
  }
  async unregisterPush():Promise<void> {await this.value('/api/v1/me/push',undefined,false,undefined,'DELETE');}
  pushContent(id:string):Promise<import('./protocol.generated.ts').PushContent> {
    return this.request('PushContent',`/api/v1/push/notifications/${encodeURIComponent(id)}`);
  }
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
  ownProfile():Promise<NativeTypes['OwnProfile']> {return this.request('OwnProfile','/api/v1/me/profile');}
  userProfile(id:string):Promise<NativeTypes['UserProfile']> {return this.request('UserProfile',`/api/v1/users/${encodeURIComponent(id)}`);}
  lookupProfile(username:string):Promise<NativeTypes['UserProfile']> {return this.request('UserProfile',`/api/v1/users/lookup?username=${encodeURIComponent(username)}`);}
  updateProfile(input:NativeTypes['UpdateProfile']):Promise<NativeTypes['ProfileReceipt']> {return this.request('ProfileReceipt','/api/v1/me',input,false,undefined,'PATCH');}
  updatePreferences(input:NativeTypes['UpdatePreferences']):Promise<NativeTypes['ProfileReceipt']> {return this.request('ProfileReceipt','/api/v1/me/preferences',input,false,undefined,'PATCH');}
  async setAvatar(input:NativeTypes['AvatarCommand'],upload?:{mime:string;bytes:Uint8Array}):Promise<NativeTypes['ProfileReceipt']> {
    if(upload && upload.bytes.length>2*1024*1024)throw new NativeError(413,'avatar_too_large');
    const path=`/api/v1/me/avatar?operation_id=${encodeURIComponent(input.operation_id)}&expected_revision=${encodeURIComponent(input.expected_revision)}`;
    const value=await this.value(path,undefined,false,undefined,upload?'PUT':'DELETE',upload?{mime:upload.mime,body:Uint8Array.from(upload.bytes).buffer}:undefined);
    return decodeNative('ProfileReceipt',value);
  }
  async avatarBytes(id:string):Promise<Uint8Array> {return await this.value(`/api/v1/avatars/${encodeURIComponent(id)}`,undefined,false,undefined,'GET',{read:true}) as Uint8Array;}
  async emojiCatalog():Promise<NativeTypes['EmojiCatalog']> {return emojiCatalog(await this.value('/api/v1/emoji'));}
  async emojiBytes(item:NativeTypes['CustomEmoji']):Promise<Uint8Array> {
    emojiCatalog({revision:item.revision,items:[item]});
    const bytes=await this.value(`/api/v1/emoji/files/${item.file_id}`,undefined,false,undefined,'GET',{file:{bytes:Number(item.bytes),mime:item.media_type}}) as Uint8Array;
    if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new NativeError(502,'invalid_emoji_image');
    return bytes;
  }
  async previewBytes(message:string,value:NativeTypes['PreviewImage']):Promise<Uint8Array> {
    const image=previewImage(value),sent=this.token;
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(message))throw new NativeError(422,'invalid_preview');
    const bytes=await this.value(`/api/v1/messages/${encodeURIComponent(message)}/previews/${image.file_id}`,undefined,false,undefined,'GET',{file:{bytes:Number(image.bytes),mime:'image/png'}}) as Uint8Array;
    const png=[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
    if(this.token!==sent||bytes.length<33||!png.every((v,i)=>bytes[i]===v)||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(16)!==image.width||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(20)!==image.height||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new NativeError(502,'invalid_preview_image');
    return bytes;
  }
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
  searchMessages(room:string,q:string,before?:string):Promise<NativeTypes['SearchPage']> {
    return this.request('SearchPage',`/api/v1/rooms/${encodeURIComponent(room)}/messages/search?q=${encodeURIComponent(q)}${before?`&before=${encodeURIComponent(before)}`:''}`);
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
  prepareUpload(input:NativeTypes['PrepareUpload']):Promise<NativeTypes['Upload']>{return this.request('Upload','/api/v1/uploads',input);}
  uploadStatus(id:string):Promise<NativeTypes['Upload']>{return this.request('Upload',`/api/v1/uploads/${encodeURIComponent(id)}`);}
  async uploadBytes(id:string,bytes:ArrayBuffer,signal?:AbortSignal):Promise<NativeTypes['Upload']>{
    if(bytes.byteLength>100*1024*1024)throw new NativeError(0,'file_too_large');
    return decodeNative('Upload',await this.value(`/api/v1/uploads/${encodeURIComponent(id)}/bytes`,undefined,false,signal,'PUT',{body:bytes,mime:'application/octet-stream',timeout:150_000}));
  }
  completeUpload(id:string,input:NativeTypes['CompleteUpload']):Promise<Message>{return this.request('Message',`/api/v1/uploads/${encodeURIComponent(id)}/complete`,input);}
  cancelUpload(id:string):Promise<NativeTypes['Upload']>{return this.request('Upload',`/api/v1/uploads/${encodeURIComponent(id)}`,undefined,false,undefined,'DELETE');}
  async uploadLocal(id:string,uri:string,send:import('./uploads.ts').NativeFileSender,signal:AbortSignal,progress:(fraction:number)=>void):Promise<NativeTypes['Upload']>{
    const sent=this.token;if(!sent)throw new NativeError(401,'session_rejected');
    const response=await send(`${this.baseUrl}/api/v1/uploads/${encodeURIComponent(id)}/bytes`,{authorization:`Bearer ${sent}`,'content-type':'application/octet-stream'},uri,signal,progress);
    if(response.status>=300&&response.status<400)throw new NativeError(502,'file_redirect_refused');
    let body:unknown;try{body=JSON.parse(response.body);}catch{throw new NativeError(502,'invalid_upload');}
    if(response.status!==200){const error=decodeNative('ApiError',body);if(response.status===401&&error.code==='session_rejected')this.surJetonRefuse?.(sent);throw new NativeError(response.status,error.code,undefined,error.request_id);}
    return decodeNative('Upload',body);
  }
  /** Keep authentication and the deadline around the entire streaming consumer. */
  async downloadFile<T>(file:NativeTypes['FileDescriptor'],fetcher:typeof fetch,consume:(response:Response)=>Promise<T>,signal?:AbortSignal,probe=false):Promise<T>{
    const sent=this.token;if(!sent)throw new NativeError(401,'session_rejected');
    const controller=new AbortController(),relay=()=>controller.abort();signal?.addEventListener('abort',relay);if(signal?.aborted)controller.abort();
    const timeout=setTimeout(relay,150_000);
    try{
      const response=await fetcher(`${this.baseUrl}/api/v1/files/${encodeURIComponent(file.id)}`,{headers:{authorization:`Bearer ${sent}`,...(probe?{range:'bytes=0-0'}:{})},redirect:'error',signal:controller.signal});
      if(!response.ok){const error=decodeNative('ApiError',await response.json());if(response.status===401&&error.code==='session_rejected')this.surJetonRefuse?.(sent);throw new NativeError(response.status,error.code,undefined,error.request_id);}
      if(response.status!==(probe?206:200)||response.headers.get('content-type')!==file.media_type||response.headers.get('content-length')!==(probe?'1':file.bytes)||probe&&response.headers.get('content-range')!==`bytes 0-0/${file.bytes}`)throw new NativeError(502,'invalid_file');
      return await consume(response);
    }finally{controller.abort();clearTimeout(timeout);signal?.removeEventListener('abort',relay);}
  }
  async fileBytes(file:NativeTypes['FileDescriptor'],signal?:AbortSignal):Promise<Uint8Array>{
    if(!/^[1-9]\d*$/.test(file.bytes) || Number(file.bytes)>100*1024*1024 || file.encrypted)throw new NativeError(0,'invalid_file');
    return await this.value(`/api/v1/files/${encodeURIComponent(file.id)}`,undefined,false,signal,'GET',{file:{bytes:Number(file.bytes),mime:file.media_type},timeout:150_000}) as Uint8Array;
  }
  history(room: string, before?: string): Promise<MessagePage> { return this.request('MessagePage', `/api/v1/rooms/${encodeURIComponent(room)}/messages${before === undefined ? '' : '?before=' + encodeURIComponent(before)}`); }
  thread(root:string,before?:string):Promise<NativeTypes['ThreadPage']>{return this.request('ThreadPage',`/api/v1/messages/${encodeURIComponent(root)}/thread${before===undefined?'':'?before='+encodeURIComponent(before)}`);}
  markThreadRead(root:string,position:string):Promise<NativeTypes['ThreadReadState']>{return this.request('ThreadReadState',`/api/v1/messages/${encodeURIComponent(root)}/thread/read`,{position});}
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

  async socketUrl(cursor: string, live=false): Promise<string> {
    const ticket: SocketTicket = await this.request('SocketTicket', '/api/v1/sync/ticket', {});
    const url = new URL(`${this.baseUrl}/api/v1/sync/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket.ticket);
    url.searchParams.set('cursor', cursor);
    if(live)url.searchParams.set('live','true');
    return url.toString();
  }
  async setPresence(status:NativeTypes['PresenceStatus']):Promise<void>{await this.value('/api/v1/me/presence',{status},false,undefined,'PUT');}
  async setTyping(room:string,input:NativeTypes['SetTyping']):Promise<void>{await this.value(`/api/v1/rooms/${encodeURIComponent(room)}/typing`,input,false,undefined,'PUT');}
  liveState():Promise<NativeTypes['LiveFrame']>{return this.request('LiveFrame','/api/v1/live');}
}
