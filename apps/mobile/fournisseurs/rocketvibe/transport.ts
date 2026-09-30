/** Native HTTP transport shared by the mobile pilot and integration tests. */
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
  surJetonRefuse: ((token: string) => void) | null = null;

  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid server URL');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetcher = fetcher;
  }

  private async value(path: string, input?: unknown, anonymous = false, signal?: AbortSignal): Promise<unknown> {
    if (!anonymous && this.token === null) throw new NativeError(401, 'session_rejected');
    const sent = anonymous ? null : this.token;
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay);
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(anonymous ? {} : { authorization: `Bearer ${this.token}` }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = decodeNative('ApiError', await response.json());
      if (response.status === 401 && error.code === 'session_rejected' && sent !== null) this.surJetonRefuse?.(sent);
      throw new NativeError(response.status, error.code);
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

  private async request<K extends keyof NativeTypes>(name: K, path: string, input?: unknown, anonymous = false, signal?: AbortSignal): Promise<NativeTypes[K]> {
    return decodeNative(name, await this.value(path, input, anonymous, signal));
  }

  async discover(signal?: AbortSignal): Promise<Discovery> {
    const discovery = await this.request('Discovery', '/.well-known/rocketvibe', undefined, true, signal);
    if (discovery.product !== 'rocketvibe' || !discovery.protocol_versions.includes(1) || discovery.api_path !== '/api/v1') throw new Error('Unsupported RocketVibe protocol');
    return discovery;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.request('Session', '/api/v1/auth/login', { username, password }, true);
    this.token = session.token;
    return session;
  }

  restore(token: string): void { this.token = token; }
  async logout(): Promise<void> { try { await this.value('/api/v1/auth/logout', {}); } finally { this.token = null; } }
  me(): Promise<NativeTypes['User']> { return this.request('User', '/api/v1/me'); }
  async users(): Promise<NativeTypes['User'][]> {
    const users = await this.value('/api/v1/users');
    if (!Array.isArray(users)) throw new Error('Invalid native directory');
    return users.map(user => decodeNative('User', user));
  }
  createRoom(input: CreateRoom): Promise<Room> { return this.request('Room', '/api/v1/rooms', input); }
  direct(input: DirectMessage): Promise<Room> { return this.request('Room', '/api/v1/direct-messages', input); }
  async addMember(room: string, user: string): Promise<void> { await this.value(`/api/v1/rooms/${encodeURIComponent(room)}/members/${encodeURIComponent(user)}`, {}); }
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
