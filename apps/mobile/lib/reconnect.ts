/**
 * Reconnection driver: exponential backoff with jitter, 1 s → 30 s.
 *
 * The jitter is not decorative: without it, every client cut off by the
 * same incident retries in the same second and they trample each other
 * (thundering herd). "Equal" jitter: half fixed, half random.
 *
 * `trigger()` is deliberately idempotent: socket loss, a failed attempt
 * and an external signal can all request it without creating concurrent
 * attempts.
 *
 * Pure: the clock and the randomness are injected, everything is tested under
 * Node without waiting a real second.
 */

export type ReconnectOptions = {
  /** The full attempt: connection + login. Rejects = we will retry. */
  connect: () => Promise<void>;
  minDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (m: ReturnType<typeof setTimeout>) => void;
};

export class Reconnector {
  private readonly connect: () => Promise<void>;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (m: ReturnType<typeof setTimeout>) => void;

  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private rerunRequested = false;
  private stopped = false;
  /** Reversible, unlike `stopped`: for the duration of a background stint. */
  private suspended = false;

  constructor(options: ReconnectOptions) {
    this.connect = options.connect;
    this.minDelayMs = options.minDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelTimer = options.cancel ?? ((m) => clearTimeout(m));
  }

  /** Next delay: 0 for the first attempt, then 1 s, 2 s… capped at 30 s. */
  private delay(): number {
    if (this.attempt === 0) return 0;
    const full = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** (this.attempt - 1));
    return full / 2 + this.random() * (full / 2);
  }

  /**
   * Requests a (re)connection. No effect if an attempt is already scheduled,
   * and if an attempt is IN FLIGHT, the request is remembered then replayed at
   * the end: a socket loss during a "successful" attempt (the socket drops
   * during the REST reload) would otherwise be swallowed, and nothing would
   * ever reconnect again.
   */
  trigger(): void {
    if (this.stopped || this.suspended || this.timer !== null) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.tryConnect();
    }, this.delay());
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    this.inFlight = true;
    this.rerunRequested = false;
    try {
      await this.connect();
      this.attempt = 0;
    } catch {
      this.attempt++;
      this.inFlight = false;
      this.trigger();
      return;
    }
    this.inFlight = false;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.trigger();
    }
  }

  /** On logout or unmount: no attempt will ever start again. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * For the duration of a background stint. Unlike `stop()`, this is
   * reversible, and it closes BOTH paths that reopened a socket in the
   * background: the already armed timer, disarmed here, and the retry that
   * the failure (or the remembered request) of an attempt in flight would
   * then ask for, which the flag blocks in `trigger()`.
   *
   * Each background attempt costs a socket that Doze will kill (which
   * triggers `onLoss` again) and a rate-limited REST `catchUpAll()`.
   */
  suspend(): void {
    this.suspended = true;
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Back in the foreground. The accumulated backoff describes a network observed
   * with the screen off: it is reset so the next attempt starts right
   * away. Otherwise a user's return (a gesture, so a pace bounded by them)
   * would cost up to thirty seconds of waiting.
   *
   * Does not revive a `stop()`ped driver: that path is final.
   */
  resume(): void {
    this.suspended = false;
    this.attempt = 0;
  }
}
