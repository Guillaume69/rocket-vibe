/**
 * Mattermost's `/api/v4/websocket` behind the `Listener` contract. The server
 * pushes every event of the account once authenticated, so `subscribe` only
 * records interest: there is nothing to arm per room.
 *
 * Probed on 11.11: the token goes in an `authentication_challenge` action, any
 * action answers `{status, seq_reply}`, an unknown one answers
 * `status: "FAIL"` with its `seq_reply` (so a waiting call is rejected, never
 * left to time out), and the `ping` action answers `pong` in `data.text`.
 */

import type { DdpEvent, DdpState, WebSocketLike } from '../../lib/ddp.ts';
import type { Listener } from '../../lib/provider.ts';

export type Expand = (name: string, data: Record<string, unknown>, broadcast: Record<string, unknown>) => Promise<DdpEvent[]>;

export type MmSocketOptions = {
  createWebSocket?: (url: string) => WebSocketLike;
  timeoutMs?: number;
  heartbeatMs?: number;
};

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class MmSocketError extends Error {}

export class MmSocket implements Listener {
  state: DdpState = 'closed';
  private readonly url: string;
  private readonly expand: Expand;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private ws: WebSocketLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  private readonly wanted = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private closedOnPurpose = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private armed: { promise: Promise<void>; resolve: () => void } = settled();

  constructor(url: string, expand: Expand, options: MmSocketOptions = {}) {
    this.url = url;
    this.expand = expand;
    this.createWebSocket = options.createWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  get wantedCount(): number {
    return this.wanted.size;
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

  async connect(authToken: string): Promise<void> {
    if (this.state !== 'closed') throw new MmSocketError('Client already connected.');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    this.armed = deferred();
    const ws = this.createWebSocket(this.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new MmSocketError('WebSocket open timed out.'));
      }, this.timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new MmSocketError('WebSocket failed to open.'));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new MmSocketError('WebSocket closed while opening.'));
      };
    }).catch((e: unknown) => {
      this.cleanUp();
      throw e;
    });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.cleanUp();
    ws.onerror = () => {
      ws.close();
      this.cleanUp();
    };
    this.state = 'connected';
    try {
      await this.call('authentication_challenge', { token: authToken });
    } catch (e) {
      this.ws?.close();
      this.cleanUp();
      throw e;
    }
    this.state = 'authenticated';
    this.armed.resolve();
    this.heartbeat = setInterval(() => {
      void this.checkAlive();
    }, this.heartbeatMs);
  }

  async checkAlive(): Promise<boolean> {
    if (this.state !== 'connected' && this.state !== 'authenticated') return false;
    try {
      await this.call('ping', {});
      return true;
    } catch {
      if ((this.state as DdpState) !== 'closed') {
        this.ws?.close();
        this.cleanUp();
      }
      return false;
    }
  }

  close(): void {
    this.closedOnPurpose = true;
    this.ws?.close();
    this.cleanUp();
  }

  reset(): void {
    this.wanted.clear();
  }

  sendTyping(channelId: string, parentId: string | null): void {
    if (this.state !== 'authenticated') return;
    this.send({ seq: ++this.seq, action: 'user_typing', data: { channel_id: channelId, parent_id: parentId ?? '' } });
  }

  private call(action: string, data: Record<string, unknown>): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new MmSocketError(`${action} unanswered.`));
      }, this.timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.send({ seq, action, data });
    });
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
    if (typeof message.seq_reply === 'number') {
      const waiting = this.pending.get(message.seq_reply);
      if (waiting === undefined) return;
      this.pending.delete(message.seq_reply);
      clearTimeout(waiting.timer);
      if (message.status === 'OK') waiting.resolve(message.data);
      else waiting.reject(new MmSocketError(String((message.error as { id?: unknown } | undefined)?.id ?? 'FAIL')));
      return;
    }
    const name = typeof message.event === 'string' ? message.event : null;
    if (name === null) return;
    const data = (message.data ?? {}) as Record<string, unknown>;
    const broadcast = (message.broadcast ?? {}) as Record<string, unknown>;
    this.chain = this.chain
      .then(() => this.expand(name, data, broadcast))
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
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new MmSocketError('Socket closed.'));
    }
    this.pending.clear();
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
