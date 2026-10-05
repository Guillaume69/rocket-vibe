/**
 * Mini DDP client for Rocket.Chat, **listening only**.
 *
 * DDP method calls are deprecated since Rocket.Chat 8.0, with removal
 * announced for 9.0: we act over REST, we listen over DDP. The only method we
 * call is `login`, which is required: spike 1.7 established that a `sub`
 * without an authenticated session gets `nosub: not-allowed`, **even on a
 * public channel**.
 *
 * Written from the DDP specification and from observing the traffic. We do not
 * copy `@rocket.chat/ddp-client`, whose licence is ambiguous.
 *
 * The `WebSocket` is injected: React Native's and Node's expose the same
 * browser API, so this module runs under Node and is tested for real.
 */

/** The subset of `WebSocket` we depend on. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type DdpEvent = {
  /** Stream name, e.g. `stream-room-messages`. */
  collection: string;
  /** Event key: a `rid`, or `<uid>/subscriptions-changed`. */
  eventKey: string;
  /** Payload. The first element carries the essentials. */
  args: unknown[];
};

export type DdpState = 'closed' | 'connecting' | 'connected' | 'authenticated';

export class DdpError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'DdpError';
    this.details = details;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type OptionsDdp = {
  createWebSocket?: (url: string) => WebSocketLike;
  /** Delay after which a `method` or a `sub` is considered lost. */
  timeoutMs?: number;
  /**
   * Server silence after which the socket is held suspect. See
   * `SILENCE_MAX_MS`. Tunable for tests, not for production.
   */
  silenceMaxMs?: number;
  /** Watchdog period. See `GUARD_MS`. */
  watchdogMs?: number;
};

/**
 * The DDP server pings its clients **every 30 s**, measured against
 * Rocket.Chat 8.5 (first ping at +15 s from `connected`, then exactly 30 s).
 * The protocol therefore GUARANTEES regular downstream traffic, even in a
 * silent room.
 *
 * Past one whole missed ping, the socket can no longer be healthy: we take the
 * silence for a death. So the threshold does not bet on network latency; it
 * follows from the rhythm the server imposes on itself.
 */
const SILENCE_MAX_MS = 45_000;
/** Check period: fine enough not to add to the threshold. */
const GUARD_MS = 15_000;

type DesiredSubscription = {
  name: string;
  eventKey: string;
  /** Number of callers. The `sub` goes out only once, the `unsub` only on the last departure. */
  refs: number;
  /** Wire identifier, or `null` if nothing is established (socket down, not yet authenticated). */
  id: string | null;
  /** `sub` being negotiated on the wire. */
  inFlight: boolean;
  /**
   * The ongoing negotiation, as a promise that NEVER rejects: it settles on
   * the server's `ready`, on a `nosub`, or on the socket's death. That is what
   * `armedSubscriptions()` waits for.
   */
  ready: Promise<void> | null;
};

type MessageDdp = {
  msg?: string;
  id?: string;
  session?: string;
  subs?: string[];
  collection?: string;
  error?: unknown;
  result?: unknown;
  fields?: { eventName?: string; args?: unknown[] };
  /** On `msg: 'error'`: the reason for the refusal, in plain text. */
  reason?: string;
  /** On `msg: 'error'`: the refused message, as we sent it. */
  offendingMessage?: { id?: string };
};

export class ClientDdp {
  readonly url: string;
  state: DdpState = 'closed';
  session: string | null = null;

  private ws: WebSocketLike | null = null;
  private counter = 0;
  private closedOnPurpose = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(e: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  /**
   * **Desired** subscriptions, indexed by `name|key`. They survive a socket
   * close, so step 5.1 can replay them: it is the only state that must cross a
   * reconnection.
   *
   * `refs` counts the callers. Two screens watching the same room must produce
   * a single `sub` on the wire, otherwise the server sends every message twice,
   * which `ROADMAP.md` holds against the official app.
   */
  private readonly wanted = new Map<string, DesiredSubscription>();
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  /**
   * Rejects the ongoing handshake. It lives outside `pending` (it has no DDP
   * `id`): without this hook, a `close()` during `connect()` would leave the
   * promise hanging until its timeout, ten seconds of zombie on every slightly
   * quick unmount.
   */
  private cancelHandshake: ((reason: unknown) => void) | null = null;
  private readonly silenceMaxMs: number;
  private readonly watchdogMs: number;
  /** Time of the last byte received from the server, all messages included. */
  private lastTraffic = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** One probe at a time: the watchdog ticks faster than it. */
  private probeInFlight = false;
  /**
   * `cleanUp()` has already run on this socket. True at first: a new client
   * has nothing to clean up. Reset to false by `connect()`.
   */
  private cleanedUp = true;

  constructor(url: string, options: OptionsDdp = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.silenceMaxMs = options.silenceMaxMs ?? SILENCE_MAX_MS;
    this.watchdogMs = options.watchdogMs ?? GUARD_MS;
    this.createWebSocket =
      options.createWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  /** Subscriptions actually established on the wire; the 3.6 debug screen uses it. */
  get subscriptionCount(): number {
    let n = 0;
    for (const s of this.wanted.values()) if (s.id !== null) n++;
    return n;
  }

  /** Requested subscriptions, established or not. Differs from the previous one if the socket is down. */
  get wantedSubscriptionCount(): number {
    return this.wanted.size;
  }

  onEvent(listener: (e: DdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notified when the connection is lost WITHOUT us asking for it, never on
   * `close()`. It is the reconnection driver's signal (5.1): notifying a
   * deliberate close would trigger a reconnection after logout.
   */
  onLoss(listener: () => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  /**
   * Opens the socket, negotiates DDP, then authenticates with the REST token.
   * `authToken` is the one from `POST /api/v1/login`: a single secret for both
   * transports.
   */
  async connect(authToken: string): Promise<void> {
    if (this.state !== 'closed') throw new DdpError('Client already connected.');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    this.cleanedUp = false;

    await new Promise<void>((resolve, reject) => {
      // The timeout CLEANS UP, it does not just reject: otherwise the state
      // stays "connecting" with an open socket, and every retry from the
      // reconnection driver would fail forever on "already connected".
      const timer = setTimeout(() => {
        const error = new DdpError(`No "connected" within ${this.timeoutMs} ms.`);
        this.ws?.close();
        this.cleanUp(error);
        reject(error);
      }, this.timeoutMs);
      this.cancelHandshake = (reason) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new DdpError('Connection interrupted.'));
      };
      const ws = this.createWebSocket(this.url);
      this.ws = ws;

      // An abandoned socket's `close` arrives asynchronously, often AFTER a new
      // one was opened. Without this identity guard, its `onclose` would reset
      // `this.ws` to null and the state to "closed" under the ongoing
      // connection's feet: the `connect` would never go out.
      const isCurrent = () => this.ws === ws;

      ws.onerror = () => {
        if (!isCurrent()) return;
        clearTimeout(timer);
        this.cleanUp(new DdpError('WebSocket error.'));
        reject(new DdpError('WebSocket error.'));
      };
      ws.onclose = () => {
        if (!isCurrent()) return;
        clearTimeout(timer);
        this.cleanUp(new DdpError('Socket closed.'));
      };
      ws.onmessage = (e) => {
        if (!isCurrent()) return;
        // BEFORE any processing: what matters to the watchdog is that a byte
        // arrived, not that it was understood.
        this.lastTraffic = Date.now();
        let m: MessageDdp;
        try {
          m = JSON.parse(String(e.data)) as MessageDdp;
        } catch {
          return; // The server should not, but we don't die for it.
        }
        if (m.msg === 'connected') {
          clearTimeout(timer);
          this.cancelHandshake = null;
          this.session = m.session ?? null;
          this.state = 'connected';
          resolve();
          return;
        }
        if (m.msg === 'failed') {
          clearTimeout(timer);
          this.cancelHandshake = null;
          // Same requirement as the timeout: leave the client reusable.
          const error = new DdpError('DDP version refused by the server.');
          ws.close();
          this.cleanUp(error);
          reject(error);
          return;
        }
        this.receive(m);
      };
      ws.onopen = () => {
        if (isCurrent()) this.send({ msg: 'connect', version: '1', support: ['1'] });
      };
    });

    try {
      await this.call('login', { resume: authToken });
    } catch (e) {
      // Without this, the socket stays open and the state stuck on "connected":
      // any later `connect()` would throw "already connected".
      this.ws?.close();
      this.cleanUp(e);
      throw e;
    }
    this.state = 'authenticated';
    this.startWatchdog();

    // Replay the desired subscriptions: those requested before authentication,
    // and those of a previous socket. That is what lets a screen subscribe
    // without caring about the transport state, and it is the mechanism the
    // reconnection (5.1) reuses as is.
    for (const entry of this.wanted.values()) this.establish(entry);
  }

  /**
   * Declares interest in a stream and returns the function that releases it.
   *
   * **Synchronous and independent of the transport state**: called before
   * authentication or after a drop, the subscription is simply remembered and
   * established as soon as possible; `connect()` replays all the desired ones
   * on authentication. The old API returned the wire identifier: it dies with
   * the socket, and a screen that used it to unsubscribe after a drop leaked
   * its reference forever.
   */
  subscribe(name: string, eventKey: string): () => void {
    const key = `${name}|${eventKey}`;
    const entry: DesiredSubscription = this.wanted.get(key) ?? {
      name,
      eventKey,
      refs: 0,
      id: null,
      inFlight: false,
      ready: null,
    };
    entry.refs++;
    this.wanted.set(key, entry);
    this.establish(entry);

    // Idempotent per caller: a double call must not steal another screen's
    // reference.
    let rendered = false;
    return () => {
      if (rendered) return;
      rendered = true;
      this.release(key);
    };
  }

  /**
   * Sends the `sub` on the wire if the state allows. One per entry: two
   * callers in the same tick share the negotiation (`inFlight`), otherwise the
   * server receives two `sub`s and duplicates every event.
   *
   * `params` always gets the `{ useCollection: false, args: [] }` object as
   * last argument: that is the convention of Rocket.Chat "streamers".
   */
  private establish(entry: DesiredSubscription): void {
    if (this.state !== 'authenticated' || entry.id !== null || entry.inFlight) return;
    const key = `${entry.name}|${entry.eventKey}`;
    const id = `s${++this.counter}`;
    entry.inFlight = true;

    entry.ready = this.waitFor(id, `sub ${entry.name}`)
      .then(() => {
        entry.inFlight = false;
        if (this.wanted.get(key) !== entry) {
          // Released during the negotiation: the server just established it,
          // we cut it at once rather than let it leak.
          this.send({ msg: 'unsub', id });
          return;
        }
        entry.id = id;
      })
      .catch(() => {
        // `nosub` or dead socket: `id` stays null. The entry stays desired and
        // will be retried on the next authentication.
        entry.inFlight = false;
      });

    this.send({
      msg: 'sub',
      id,
      name: entry.name,
      params: [entry.eventKey, { useCollection: false, args: [] }],
    });
  }

  /** Cuts the subscription on the wire only when the last caller leaves. */
  private release(key: string): void {
    const entry = this.wanted.get(key);
    if (entry === undefined) return;
    if (--entry.refs > 0) return;
    this.wanted.delete(key);
    // If a negotiation is in flight, its `.then` will see the entry gone and
    // send the `unsub` itself.
    if (entry.id !== null) this.send({ msg: 'unsub', id: entry.id });
  }

  close(): void {
    this.closedOnPurpose = true;
    this.ws?.close();
    this.cleanUp(new DdpError('Client closed.'));
  }

  /**
   * Resolved when the server has ARMED the subscriptions desired at the time
   * of the call: their `ready` received, their `nosub` seen, or the socket
   * dead.
   *
   * It is the only EXACT signal of when the stream starts covering. A REST
   * read started after it can no longer leave a gap: everything the server
   * publishes afterwards comes over the wire. Connection setup uses it instead
   * of a delay; correctness must depend neither on latency nor on network
   * quality (see `lib/connectionSetup.ts`).
   *
   * Never rejects: a failing subscription stays desired and will be replayed
   * on the next authentication.
   */
  async armedSubscriptions(): Promise<void> {
    const negotiations: Promise<void>[] = [];
    for (const entry of this.wanted.values()) {
      if (entry.ready !== null) negotiations.push(entry.ready);
    }
    await Promise.all(negotiations);
  }

  /**
   * Silence watchdog. A socket can die WITHOUT the WebSocket ever calling
   * `onclose`: the server sends its FIN, the socket goes to CLOSE-WAIT on the
   * OS side, and nothing reaches JS. The client then believes itself
   * `authenticated` forever: `onLoss` does not fire, the reconnection driver is
   * never woken, and no message arrives any more.
   *
   * Seen for real, reproduced on the AVD: after an attachment upload, four
   * sockets to the server in CLOSE-WAIT, no DDP event, and the following
   * messages never received, until a move to the background (which did probe)
   * or an app restart.
   *
   * The threshold is not a bet on the network but a reading of the protocol:
   * the server pings every 30 s (measured), so a 45 s silence proves a ping
   * was lost. We don't cut for all that: we PROBE, and the missing pong
   * decides.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastTraffic = Date.now();
    this.watchdog = setInterval(() => {
      if (this.state === 'closed' || this.probeInFlight) return;
      if (Date.now() - this.lastTraffic < this.silenceMaxMs) return;
      this.probeInFlight = true;
      void this.checkAlive().finally(() => {
        this.probeInFlight = false;
      });
    }, this.watchdogMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Liveness probe: a DDP ping whose pong we wait for. A half-dead socket (NAT
   * dropped during sleep, with neither FIN nor RST) will never answer AND never
   * close: we clean it up ourselves, which notifies `onLoss` and lets the
   * reconnection driver take over.
   */
  async checkAlive(): Promise<boolean> {
    // An ongoing NEGOTIATION is not probed. Probed on the 8.5.1 bench: a
    // `ping` sent before the `connect` gets `{msg:'error', reason:'Must
    // connect first', offendingMessage:{id}}`, never a `pong`. The `catch`
    // below would then close a socket that, ten seconds later, has finished
    // its login and replayed its subscriptions. The negotiation already has
    // its own timeout (`timeoutMs`): it does not need watching.
    //
    // The `connected` state (handshake done, login not yet answered), on the
    // other hand, can be probed: same probe, `pong` received.
    if (this.state !== 'connected' && this.state !== 'authenticated') return false;
    const id = `v${++this.counter}`;
    try {
      const promise = this.waitFor(id, 'liveness probe');
      this.send({ msg: 'ping', id });
      await promise;
      return true;
    } catch {
      // The cast: TypeScript does not see that `state` may have changed during
      // the await (a concurrent drop may already have cleaned up).
      if ((this.state as DdpState) !== 'closed') {
        this.ws?.close();
        this.cleanUp(new DdpError('Liveness probe unanswered: socket dead.'));
      }
      return false;
    }
  }

  /** The only DDP method still called: `login`. See the file header. */
  private call(method: string, ...params: unknown[]): Promise<unknown> {
    const id = `m${++this.counter}`;
    const promise = this.waitFor(id, `method ${method}`);
    this.send({ msg: 'method', id, method, params });
    return promise;
  }

  private waitFor(id: string, what: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DdpError(`${what}: neither result nor error within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private finish(id: string, value: unknown, error?: unknown): void {
    const wait = this.pending.get(id);
    if (!wait) return;
    this.pending.delete(id);
    clearTimeout(wait.timer);
    error === undefined ? wait.resolve(value) : wait.reject(error);
  }

  private receive(m: MessageDdp): void {
    switch (m.msg) {
      case 'ping':
        // The server cuts the socket without a pong. The `id` is present only
        // if the ping carried one.
        this.send(m.id === undefined ? { msg: 'pong' } : { msg: 'pong', id: m.id });
        break;

      case 'pong':
        // Answer to OUR ping (liveness probe).
        if (m.id !== undefined) this.finish(m.id, 'pong');
        break;

      case 'result':
        if (m.id !== undefined) {
          this.finish(
            m.id,
            m.result,
            m.error === undefined ? undefined : new DdpError('Method refused.', m.error),
          );
        }
        break;

      case 'ready':
        for (const id of m.subs ?? []) this.finish(id, 'ready');
        break;

      case 'nosub':
        if (m.id !== undefined) {
          this.finish(m.id, undefined, new DdpError('Subscription refused.', m.error));
        }
        break;

      case 'error': {
        // Refusal of a malformed or out-of-sequence message. The server will
        // NEVER answer the offending id: without this case, the wait hangs
        // until `timeoutMs` and its failure is blamed on the socket. Recorded
        // on the 8.5.1 bench: the error does carry the refused message, hence
        // its `id`, so we can reject the right wait, not all of them.
        const id = m.offendingMessage?.id;
        if (typeof id === 'string') {
          this.finish(id, undefined, new DdpError(`Message refused: ${m.reason ?? 'no reason'}`));
        }
        break;
      }

      case 'changed': {
        // Streamer format: `collection` = stream name, the key is in
        // `fields.eventName`, the payload in `fields.args`.
        const eventKey = m.fields?.eventName;
        if (m.collection === undefined || eventKey === undefined) break;
        const event: DdpEvent = {
          collection: m.collection,
          eventKey,
          args: m.fields?.args ?? [],
        };
        // A listener that throws must not stop the others from receiving.
        for (const listener of [...this.listeners]) {
          try {
            listener(event);
          } catch {
            /* deliberately ignored */
          }
        }
        break;
      }

      default:
        // `added`, `removed`, `updated`: moot when useCollection=false.
        break;
    }
  }

  private send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  /**
   * Rejects everything in flight: without this, the promises would hang.
   *
   * The **desired** subscriptions survive: they are what step 5.1 replays on
   * reconnection. Only their wire identifiers are forgotten, since they
   * belonged to the dead socket.
   *
   * **Idempotent.** A socket dying during login comes through here twice: once
   * via `onclose`, once via `connect()`'s `catch`, the login wait having been
   * rejected by the first pass. Without an early exit, `onLoss` would fire
   * twice, and the second pass would re-emit the event on an already fully
   * emptied object.
   */
  private cleanUp(reason: unknown): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.stopWatchdog();
    // Detach the handlers: an abandoned socket must say nothing more.
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    // An in-flight negotiation is rejected at once, not at the end of the timeout.
    this.cancelHandshake?.(reason);
    this.cancelHandshake = null;
    for (const [id] of this.pending) this.finish(id, undefined, reason);
    this.pending.clear();
    for (const s of this.wanted.values()) {
      s.id = null;
      s.inFlight = false;
    }
    this.state = 'closed';
    this.session = null;
    this.ws = null;

    if (!this.closedOnPurpose) {
      for (const listener of [...this.lossListeners]) {
        try {
          listener();
        } catch {
          /* a throwing listener does not block the others */
        }
      }
    }
  }

  /** Forgets everything, desired subscriptions included. On logout. */
  reset(): void {
    this.wanted.clear();
  }
}
