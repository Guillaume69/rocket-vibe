/**
 * kChat real time: Infomaniak replaced Mattermost's WebSocket with the Pusher
 * protocol (read in `Infomaniak/mobile-kchat`, `webapp-kChat`; no public spec
 * of their server). Connection on `wss://<WebsocketURL>/app/kchat-key`, then
 * each channel is authorized by the team server (`POST /broadcasting/auth`,
 * form `channel_name` + `socket_id`, bearer token) before `pusher:subscribe`.
 *
 * Event names are Mattermost's and the Pusher `data` decodes straight into the
 * Mattermost event's `data` (no `{event, broadcast, seq}` envelope), with
 * nested documents as objects rather than JSON strings: `live.ts` and the
 * translator accept both.
 */

import type { DdpEvent, DdpState, WebSocketLike } from '../../lib/ddp.ts';
import type { Listener } from '../../lib/provider.ts';
import type { MmClient } from './client.ts';
import type { Expand } from './socket.ts';

const DEFAULT_HOST = 'websocket.kchat.infomaniak.com';
const APP_KEY = 'kchat-key';
const PROTOCOL = 7;

export type KchatPusherOptions = {
  createWebSocket?: (url: string) => WebSocketLike;
  timeoutMs?: number;
};

export class KchatPusherError extends Error {}

type Waiter = { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class KchatPusher implements Listener {
  state: DdpState = 'closed';
  private readonly client: MmClient;
  private readonly expand: Expand;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  private ws: WebSocketLike | null = null;
  private socketId: string | null = null;
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<(event: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  private readonly wanted = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private closedOnPurpose = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private armed: { promise: Promise<void>; resolve: () => void } = { promise: Promise.resolve(), resolve: () => {} };

  constructor(client: MmClient, expand: Expand, options: KchatPusherOptions = {}) {
    this.client = client;
    this.expand = expand;
    this.createWebSocket = options.createWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
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

  subscribe(name: string, eventKey: string): () => void {
    const key = `${name}\u0000${eventKey}`;
    this.wanted.set(key, (this.wanted.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.wanted.get(key) ?? 1) - 1;
      if (left <= 0) this.wanted.delete(key);
      else this.wanted.set(key, left);
    };
  }

  armedSubscriptions(): Promise<void> {
    return this.armed.promise;
  }

  reset(): void {
    this.wanted.clear();
  }

  async connect(): Promise<void> {
    if (this.state !== 'closed') throw new KchatPusherError('Client already connected.');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    let release: () => void = () => {};
    this.armed = { promise: new Promise<void>((r) => (release = r)), resolve: () => release() };
    try {
      const [config, me] = await Promise.all([
        this.client.get<Record<string, unknown>>('/config/client', { query: { format: 'old' } }).catch(() => ({}) as Record<string, unknown>),
        this.client.get<Record<string, unknown>>('/users/me'),
      ]);
      this.stillWanted();
      const host = hostOf(config.WebsocketURL) ?? DEFAULT_HOST;
      await this.open(`wss://${host}/app/${APP_KEY}?protocol=${PROTOCOL}&client=js&version=8.3.0&flash=false`);
      const channels = [
        typeof me.team_id === 'string' ? `private-team.${me.team_id}` : null,
        typeof me.user_id === 'number' || typeof me.user_id === 'string' ? `presence-user.${me.user_id}` : null,
        typeof me.id === 'string' ? `presence-teamUser.${me.id}` : null,
      ].filter((c): c is string => c !== null);
      for (const channel of channels) {
        this.stillWanted();
        await this.join(channel);
      }
      this.stillWanted();
    } catch (e) {
      this.ws?.close();
      this.cleanUp();
      throw e;
    }
    this.state = 'authenticated';
    this.armed.resolve();
  }

  async checkAlive(): Promise<boolean> {
    if (this.state !== 'connected' && this.state !== 'authenticated') return false;
    try {
      const pong = this.wait('pusher:pong');
      this.send({ event: 'pusher:ping', data: {} });
      await pong;
      return true;
    } catch {
      if ((this.state as DdpState) !== 'closed') {
        this.ws?.close();
        this.cleanUp();
      }
      return false;
    }
  }

  /** `close()` while connecting: what follows must not open or keep a socket. */
  private stillWanted(): void {
    if (this.closedOnPurpose) throw new KchatPusherError('Closed while connecting.');
  }

  close(): void {
    this.closedOnPurpose = true;
    this.ws?.close();
    this.cleanUp();
  }

  private async open(url: string): Promise<void> {
    const ws = this.createWebSocket(url);
    this.ws = ws;
    const established = this.wait('pusher:connection_established');
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.cleanUp();
    ws.onerror = () => {
      ws.close();
      this.cleanUp();
    };
    const data = await established;
    this.socketId = typeof data.socket_id === 'string' ? data.socket_id : null;
    if (this.socketId === null) throw new KchatPusherError('Connection without a socket id.');
    this.state = 'connected';
    const activity = typeof data.activity_timeout === 'number' && data.activity_timeout > 0 ? data.activity_timeout : 120;
    this.heartbeat = setInterval(() => {
      void this.checkAlive();
    }, activity * 1000);
  }

  private async join(channel: string): Promise<void> {
    const auth = await this.client.postForm<Record<string, unknown>>(`${this.client.baseUrl}/broadcasting/auth`, {
      channel_name: channel,
      socket_id: this.socketId ?? '',
    });
    const joined = this.wait(`pusher_internal:subscription_succeeded:${channel}`);
    this.send({ event: 'pusher:subscribe', data: { channel, auth: auth.auth, channel_data: auth.channel_data } });
    await joined;
  }

  private wait(key: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(key) ?? [];
        this.waiters.set(key, list.filter((w) => w.timer !== timer));
        reject(new KchatPusherError(`${key} unanswered.`));
      }, this.timeoutMs);
      const list = this.waiters.get(key) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(key, list);
    });
  }

  private settle(key: string, data: Record<string, unknown>): boolean {
    const list = this.waiters.get(key);
    if (list === undefined || list.length === 0) return false;
    this.waiters.delete(key);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    }
    return true;
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(message));
    } catch {
      /* the close handler cleans up */
    }
  }

  private receive(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const name = typeof message.event === 'string' ? message.event : null;
    if (name === null) return;
    const data = decode(message.data);
    if (name === 'pusher:ping') {
      this.send({ event: 'pusher:pong', data: {} });
      return;
    }
    if (name === 'pusher:error') {
      const code = typeof data.code === 'number' ? data.code : 0;
      for (const [key, list] of this.waiters) {
        for (const waiter of list) {
          clearTimeout(waiter.timer);
          waiter.reject(new KchatPusherError(`pusher:error ${code}`));
        }
        this.waiters.delete(key);
      }
      return;
    }
    if (name === 'pusher_internal:subscription_succeeded') {
      this.settle(`${name}:${String(message.channel ?? '')}`, data);
      return;
    }
    if (name.startsWith('pusher')) {
      this.settle(name, data);
      return;
    }
    if (name.startsWith('client-')) return;
    this.chain = this.chain
      .then(() => this.expand(name, data, {}))
      .then((events) => {
        if (this.state === 'closed') return;
        for (const event of events) this.emit(event);
      })
      .catch(() => {
        /* a failed enrichment loses one event; the next catch-up brings it back */
      });
  }

  private emit(event: DdpEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* one throwing listener does not silence the others */
      }
    }
  }

  private cleanUp(): void {
    if (this.state === 'closed' && this.ws === null) return;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    this.ws = null;
    this.socketId = null;
    for (const [key, list] of this.waiters) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(new KchatPusherError('Socket closed.'));
      }
      this.waiters.delete(key);
    }
    this.state = 'closed';
    this.armed.resolve();
    if (!this.closedOnPurpose) {
      for (const listener of [...this.lossListeners]) {
        try {
          listener();
        } catch {
          /* idem */
        }
      }
    }
  }
}

function decode(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
