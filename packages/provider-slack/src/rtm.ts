/**
 * Slack's RTM socket behind the `Listener` contract. `connect` asks
 * `rtm.connect` for a socket URL and opens it with the session cookie; the
 * stream only counts once Slack's `hello` arrived, never on the upgrade alone,
 * since an `error` frame can follow a successful one. Slack pushes every event
 * of the account, so `subscribe` only records interest.
 *
 * Liveness is Slack's own `ping`, answered by a `pong` carrying `reply_to`:
 * one every 30 s, and two left unanswered drop the socket.
 */

import type { DdpEvent, DdpState, WebSocketLike } from '@rocket-vibe/provider-api/ddp';
import type { Listener } from '@rocket-vibe/provider-api/provider';
import type { CreateRtmSocket, SlackClient } from './client.ts';
import { SlackError } from './client.ts';

type Doc = Record<string, unknown>;

export type Expand = (frame: Doc) => Promise<DdpEvent[]>;

export type SlackRtmOptions = {
  createSocket?: CreateRtmSocket;
  timeoutMs?: number;
  heartbeatMs?: number;
};

const MISSED_PONGS = 2;
const TYPING_EVERY_MS = 3_000;

type Waiting = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SlackRtm implements Listener {
  state: DdpState = 'closed';
  private readonly client: SlackClient;
  private readonly expand: Expand;
  private readonly createSocket: CreateRtmSocket;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private ws: WebSocketLike | null = null;
  private id = 0;
  private readonly pongs = new Map<number, Waiting>();
  private missed = 0;
  private readonly listeners = new Set<(event: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  private readonly wanted = new Map<string, number>();
  private readonly typedAt = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private closedOnPurpose = false;
  /** Fails the handshake `connect` is waiting on, if any. */
  private handshake: ((code: string) => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private armed: { promise: Promise<void>; resolve: () => void } = settled();
  private presenceIds: string[] = [];

  constructor(client: SlackClient, expand: Expand, options: SlackRtmOptions = {}) {
    this.client = client;
    this.expand = expand;
    this.createSocket = options.createSocket ?? ((url, headers) =>
      new (WebSocket as unknown as new (u: string, p: undefined, o: { headers: Record<string, string> }) => WebSocketLike)(url, undefined, { headers }));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
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

  async connect(_authToken: string): Promise<void> {
    if (this.state !== 'closed') throw new SlackError('already_connected');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    this.armed = deferred();
    let ws: WebSocketLike;
    try {
      ws = await this.client.openSocket(this.createSocket);
    } catch (e) {
      this.cleanUp(true);
      throw e;
    }
    if (this.closedOnPurpose) {
      ws.close();
      this.cleanUp(true);
      throw new SlackError('cancelled');
    }
    this.ws = ws;
    this.state = 'connected';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SlackError('rtm_timeout')), this.timeoutMs);
      const fail = (code: string) => {
        clearTimeout(timer);
        this.handshake = null;
        reject(new SlackError(code));
      };
      this.handshake = fail;
      ws.onmessage = (e) => {
        const frame = parse(e.data);
        if (frame === null) return;
        if (frame.type === 'hello') {
          clearTimeout(timer);
          this.handshake = null;
          resolve();
        } else if (frame.type === 'error') {
          fail(rtmError(frame));
        }
      };
      ws.onerror = () => fail('rtm_failed');
      ws.onclose = () => fail('rtm_closed');
    }).catch((e: unknown) => {
      ws.close();
      this.cleanUp(true);
      throw e;
    });
    if (this.closedOnPurpose) throw new SlackError('cancelled');
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.cleanUp();
    ws.onerror = () => {
      ws.close();
      this.cleanUp();
    };
    this.state = 'authenticated';
    if (this.presenceIds.length > 0) this.send({ type: 'presence_sub', ids: this.presenceIds });
    this.armed.resolve();
    this.heartbeat = setInterval(() => {
      void this.checkAlive();
    }, this.heartbeatMs);
  }

  async checkAlive(): Promise<boolean> {
    if (this.state !== 'authenticated') return false;
    const id = ++this.id;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pongs.delete(id);
          reject(new SlackError('rtm_pong_missing'));
        }, this.timeoutMs);
        this.pongs.set(id, { resolve, reject, timer });
        this.send({ id, type: 'ping' });
      });
      this.missed = 0;
      return true;
    } catch {
      if ((this.state as DdpState) === 'closed') return false;
      if (++this.missed < MISSED_PONGS) return true;
      this.ws?.close();
      this.cleanUp();
      return false;
    }
  }

  /** One `typing` frame per room every few seconds while typing; Slack expires it itself. */
  sendTyping(channel: string): void {
    if (this.state !== 'authenticated') return;
    const now = Date.now();
    if (now - (this.typedAt.get(channel) ?? 0) < TYPING_EVERY_MS) return;
    this.typedAt.set(channel, now);
    this.send({ id: ++this.id, type: 'typing', channel });
  }

  /**
   * The people whose presence Slack pushes, replacing the previous list; kept
   * for every later socket. Slack answers with their current presence.
   */
  watchPresence(ids: readonly string[]): void {
    const next = [...new Set(ids)].sort();
    if (next.length === this.presenceIds.length && next.every((id, n) => id === this.presenceIds[n])) return;
    this.presenceIds = next;
    if (this.state === 'authenticated') this.send({ type: 'presence_sub', ids: next });
  }

  stopTyping(channel: string): void {
    this.typedAt.delete(channel);
  }

  close(): void {
    this.closedOnPurpose = true;
    this.handshake?.('cancelled');
    this.ws?.close();
    this.cleanUp();
  }

  reset(): void {
    this.wanted.clear();
  }

  private send(frame: Doc): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      /* the close handler cleans up */
    }
  }

  private receive(raw: unknown): void {
    const frame = parse(raw);
    if (frame === null) return;
    if (frame.type === 'pong' || (frame.reply_to !== undefined && frame.type === undefined)) {
      const id = typeof frame.reply_to === 'number' ? frame.reply_to : null;
      const waiting = id === null ? undefined : this.pongs.get(id);
      if (id !== null && waiting !== undefined) {
        this.pongs.delete(id);
        clearTimeout(waiting.timer);
        waiting.resolve();
      }
      return;
    }
    if (frame.type === 'goodbye') {
      this.ws?.close();
      this.cleanUp();
      return;
    }
    if (typeof frame.type !== 'string') return;
    this.chain = this.chain
      .then(() => this.expand(frame))
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

  private cleanUp(silent = false): void {
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
    for (const [, waiting] of this.pongs) {
      clearTimeout(waiting.timer);
      waiting.reject(new SlackError('rtm_closed'));
    }
    this.pongs.clear();
    this.missed = 0;
    this.typedAt.clear();
    this.state = 'closed';
    this.armed.resolve();
    if (!this.closedOnPurpose && !silent) {
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

function parse(raw: unknown): Doc | null {
  try {
    const value: unknown = JSON.parse(String(raw));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : null;
  } catch {
    return null;
  }
}

/** An `error` frame's code, kept to Slack's own vocabulary. */
function rtmError(frame: Doc): string {
  const error = frame.error;
  const msg = typeof error === 'object' && error !== null ? (error as Doc).msg : null;
  const code = typeof msg === 'string' && /^[a-z_]{1,64}$/.test(msg) ? msg : 'rtm_error';
  return code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function settled(): { promise: Promise<void>; resolve: () => void } {
  return { promise: Promise.resolve(), resolve: () => {} };
}
