/**
 * Teams' Trouter connection behind the `Listener` contract. `connect`
 * allocates an endpoint, opens its socket.io 0.9 socket and authenticates it,
 * then registers the endpoint so every conversation's chat events arrive:
 * nothing is subscribed per room. Each pushed request is answered and
 * acknowledged, or Trouter delivers it again. Mirrors
 * `crates/rv-teams/src/live.rs` and `frames.rs`.
 */

import type { DdpEvent, DdpState, WebSocketLike } from '../../lib/ddp.ts';
import type { Listener } from '../../lib/provider.ts';
import { TeamsError, type TeamsTokens } from './auth.ts';

type Doc = Record<string, unknown>;

export type Frame =
  | { kind: 'connect' }
  | { kind: 'heartbeat' }
  | { kind: 'event'; name: string }
  | { kind: 'request'; envelope: Doc; ack: string | null }
  | { kind: 'other' };

/** A socket.io 0.9 frame, `type:id:endpoint:data`. */
export function parseFrame(text: string): Frame {
  const parts = text.split(':');
  const type = parts[0], id = (parts[1] ?? '').replace(/\+$/, ''), data = parts.slice(3).join(':');
  const json = (): Doc | null => {
    try {
      const value = JSON.parse(data) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : null;
    } catch {
      return null;
    }
  };
  switch (type) {
    case '1': return { kind: 'connect' };
    case '2': return { kind: 'heartbeat' };
    case '5': {
      const name = json()?.name;
      return typeof name === 'string' ? { kind: 'event', name } : { kind: 'other' };
    }
    case '3': {
      const envelope = json();
      return envelope ? { kind: 'request', envelope, ack: id || null } : { kind: 'other' };
    }
    default: return { kind: 'other' };
  }
}

export const HEARTBEAT = '2::';

export function authenticateFrame(skype: string, connectParams: Doc): string {
  return `5:::${JSON.stringify({ name: 'user.authenticate', args: [{ headers: { 'X-Skypetoken': skype }, connectparams: connectParams }] })}`;
}

/** The answer a pushed request expects. */
export function replyFrame(envelope: Doc): string | null {
  if (envelope.id === undefined) return null;
  const request = JSON.stringify({ id: envelope.id, src: 'rv' });
  return `3:::${JSON.stringify({ id: envelope.id, status: 200, headers: { 'trouter-request': request, 'trouter-client': '{"cd":0}' }, body: '' })}`;
}

/** A pushed request's chat event: its resource type and resource, the conversation link kept on it. */
export function chatEvent(envelope: Doc): { name: string; resource: Doc } | null {
  let body: unknown = envelope.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body) as unknown; } catch { return null; }
  }
  const doc = body as Doc | null;
  const name = doc?.resourceType, resource = doc?.resource;
  if (typeof name !== 'string' || typeof resource !== 'object' || resource === null) return null;
  const out = { ...(resource as Doc) };
  if (out.conversationLink === undefined && typeof doc!.resourceLink === 'string') {
    out.conversationLink = doc!.resourceLink.split('/messages/')[0];
  }
  return { name, resource: out };
}

/** An `https` URL on one of Trouter's hosts. */
export function trouterUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === 'https:' && !url.username && url.hostname.toLowerCase().endsWith('.trouter.teams.microsoft.com') ? url : null;
}

export function endpointId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Expand = (name: string, resource: Doc) => Promise<DdpEvent[]>;
export type CreateSocket = (url: string, headers: Record<string, string>) => WebSocketLike;
export type TrouterOptions = { fetch?: typeof fetch; createSocket?: CreateSocket; timeoutMs?: number };

const CLIENT_INFO = JSON.stringify({ cv: '2026.10.0.1', ua: 'TeamsCDL', hr: '', v: '1415/26.10.0.0' });
/** Trouter's heartbeat is 70 s: three missed are a dead socket. */
const SILENCE_MS = 210_000;
const REGISTER_EVERY_MS = 6 * 3600_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

export class TeamsTrouter implements Listener {
  state: DdpState = 'closed';
  private readonly tokens: TeamsTokens;
  private readonly expand: Expand;
  private readonly fetcher: typeof fetch;
  private readonly createSocket: CreateSocket;
  private readonly timeoutMs: number;
  private ws: WebSocketLike | null = null;
  private readonly listeners = new Set<(event: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private closedOnPurpose = false;
  private lastTraffic = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private armed = deferred();

  constructor(tokens: TeamsTokens, expand: Expand, options: TrouterOptions = {}) {
    this.tokens = tokens;
    this.expand = expand;
    this.fetcher = options.fetch ?? fetch;
    this.createSocket = options.createSocket ?? ((url, headers) =>
      new (WebSocket as unknown as new (u: string, p: undefined, o: { headers: Record<string, string> }) => WebSocketLike)(url, undefined, { headers }));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  onEvent(listener: (event: DdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLoss(listener: () => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  subscribe(): () => void {
    return () => {};
  }

  armedSubscriptions(): Promise<void> {
    return this.armed.promise;
  }

  reset(): void {}

  async checkAlive(): Promise<boolean> {
    return this.state === 'authenticated' && Date.now() - this.lastTraffic < SILENCE_MS;
  }

  async connect(): Promise<void> {
    if (this.state !== 'closed') throw new TeamsError('already_connected');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    this.armed = deferred();
    try {
      await this.open();
    } catch (e) {
      this.cleanUp(true);
      throw e;
    }
  }

  private async open(): Promise<void> {
    const { skype, routes } = await this.tokens.chat();
    const base = trouterUrl(routes.trouter);
    if (!base) throw new TeamsError('trouter_route');
    const epid = endpointId();
    const allocate = new URL('/v4/a', base);
    allocate.searchParams.set('epid', epid);
    allocate.searchParams.set('tc', CLIENT_INFO);
    const allocated = (await (await this.fetcher(allocate.href, { method: 'POST', headers: { 'X-Skypetoken': skype, 'content-type': 'text/plain' } })).json()) as Doc;
    const socketio = trouterUrl(allocated.socketio), surl = trouterUrl(allocated.surl);
    const params = (allocated.connectparams ?? {}) as Doc;
    if (!socketio || !surl) throw new TeamsError('trouter_allocate');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string') query.set(k, v);
    query.set('v', 'v4');
    query.set('tc', CLIENT_INFO);
    query.set('timeout', '40');
    query.set('auth', 'true');
    query.set('epid', epid);
    query.set('cor_id', endpointId());
    query.set('con_num', `${Date.now()}_1`);
    const handshake = new URL('socket.io/1/', socketio);
    handshake.search = query.toString();
    const sid = (await (await this.fetcher(handshake.href, { headers: { 'X-Skypetoken': skype } })).text()).split(':')[0] ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new TeamsError('trouter_handshake');
    if (this.closedOnPurpose) throw new TeamsError('cancelled');
    const socket = new URL(`socket.io/1/websocket/${sid}`, socketio);
    socket.protocol = 'wss:';
    socket.search = query.toString();
    const ws = this.createSocket(socket.href, { 'X-Skypetoken': skype });
    this.ws = ws;
    this.state = 'connected';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TeamsError('trouter_timeout')), this.timeoutMs);
      ws.onmessage = (e) => {
        if (typeof e.data === 'string' && parseFrame(e.data).kind === 'connect') {
          clearTimeout(timer);
          ws.send(authenticateFrame(skype, params));
          resolve();
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new TeamsError('trouter_failed')); };
      ws.onclose = () => { clearTimeout(timer); reject(new TeamsError('trouter_closed')); };
    });
    if (!(await this.register(epid, surl.href))) throw new TeamsError('trouter_register');
    if (this.closedOnPurpose) throw new TeamsError('cancelled');
    ws.onmessage = (e) => { if (typeof e.data === 'string') this.receive(e.data); };
    ws.onclose = () => this.cleanUp();
    ws.onerror = () => { ws.close(); this.cleanUp(); };
    this.lastTraffic = Date.now();
    this.state = 'authenticated';
    this.armed.resolve();
    this.timers.push(setInterval(() => {
      if (Date.now() - this.lastTraffic > SILENCE_MS) { this.ws?.close(); this.cleanUp(); }
    }, 30_000));
    this.timers.push(setInterval(() => {
      void this.register(epid, surl.href).then((ok) => { if (!ok) { this.ws?.close(); this.cleanUp(); } });
    }, REGISTER_EVERY_MS));
  }

  private async register(epid: string, surl: string): Promise<boolean> {
    try {
      const { skype, routes } = await this.tokens.chat();
      if (!routes.registrar) return false;
      const response = await this.fetcher(routes.registrar, {
        method: 'POST',
        headers: { 'X-Skypetoken': skype, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientDescription: { appId: 'TeamsCDLWebWorker', aesKey: '', languageId: 'en-US', platform: 'edge', templateKey: 'TeamsCDLWebWorker_2.6', platformUIVersion: '49/26.10.0.0' },
          registrationId: epid,
          nodeId: '',
          transports: { TROUTER: [{ context: '', path: surl, ttl: 86400 }] },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private send(text: string): void {
    try { this.ws?.send(text); } catch { /* the close handler cleans up */ }
  }

  private receive(text: string): void {
    this.lastTraffic = Date.now();
    const frame = parseFrame(text);
    switch (frame.kind) {
      case 'heartbeat':
        this.send(HEARTBEAT);
        return;
      case 'event':
        if (frame.name === 'trouter.message_loss') { this.ws?.close(); this.cleanUp(); }
        return;
      case 'request': {
        const reply = replyFrame(frame.envelope);
        if (reply) this.send(reply);
        if (frame.ack) this.send(`6:::${frame.ack}`);
        const event = chatEvent(frame.envelope);
        if (!event) return;
        this.chain = this.chain
          .then(() => this.expand(event.name, event.resource))
          .then((events) => { if (this.state !== 'closed') for (const e of events) this.emit(e); })
          .catch(() => { /* a lost event comes back with the next catch-up */ });
        return;
      }
      default:
        return;
    }
  }

  private emit(event: DdpEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* one throwing listener does not silence the others */ }
    }
  }

  close(): void {
    this.closedOnPurpose = true;
    this.ws?.close();
    this.cleanUp();
  }

  private cleanUp(silent = false): void {
    if (this.state === 'closed' && this.ws === null) return;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    this.ws = null;
    this.state = 'closed';
    this.armed.resolve();
    if (!this.closedOnPurpose && !silent) for (const fn of [...this.lossListeners]) fn();
  }
}
