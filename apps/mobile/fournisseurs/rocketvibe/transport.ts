/** Native protocol pilot. Not registered in the app until SQLite/session integration is ready. */
import type { CreateRoom, Discovery, DirectMessage, Message, MessagePage, NativeTypes, Room, SendMessage, Session, Snapshot, SocketTicket, SyncBatch } from './protocol.generated.ts';
import { decodeNative } from './validation.ts';

export class NativeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'NativeError';
    this.status = status;
    this.code = code;
  }
}

export class NativeTransport {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private token: string | null = null;

  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid server URL');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetcher = fetcher;
  }

  private async request<K extends keyof NativeTypes>(name: K, path: string, input?: unknown, anonymous = false): Promise<NativeTypes[K]> {
    if (!anonymous && this.token === null) throw new NativeError(401, 'session_rejected');
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(anonymous ? {} : { authorization: `Bearer ${this.token}` }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = decodeNative('ApiError', await response.json());
      throw new NativeError(response.status, error.code);
    }
    return decodeNative(name, await response.json());
  }

  async discover(): Promise<Discovery> {
    const discovery = await this.request('Discovery', '/.well-known/rocketvibe', undefined, true);
    if (discovery.product !== 'rocketvibe' || !discovery.protocol_versions.includes(1) || discovery.api_path !== '/api/v1') throw new Error('Unsupported RocketVibe protocol');
    return discovery;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.request('Session', '/api/v1/auth/login', { username, password }, true);
    this.token = session.token;
    return session;
  }

  restore(token: string): void { this.token = token; }
  me(): Promise<NativeTypes['User']> { return this.request('User', '/api/v1/me'); }
  createRoom(input: CreateRoom): Promise<Room> { return this.request('Room', '/api/v1/rooms', input); }
  direct(input: DirectMessage): Promise<Room> { return this.request('Room', '/api/v1/direct-messages', input); }
  send(room: string, input: SendMessage): Promise<Message> { return this.request('Message', `/api/v1/rooms/${encodeURIComponent(room)}/messages`, input); }
  history(room: string, before?: string): Promise<MessagePage> { return this.request('MessagePage', `/api/v1/rooms/${encodeURIComponent(room)}/messages${before === undefined ? '' : '?before=' + encodeURIComponent(before)}`); }
  snapshot(): Promise<Snapshot> { return this.request('Snapshot', '/api/v1/sync/snapshot'); }
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
