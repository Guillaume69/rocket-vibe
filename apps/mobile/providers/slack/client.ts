/** Slack Web API in session mode. Credentials never leave the fixed Slack API origin. */
export type SlackIdentity = { key: string; teamId: string; userId: string; team: string; user: string; origin: string };
export type SlackAccount = { teamId: string; userId: string };
export type SlackPage<T> = { items: T[]; nextCursor: string | null };

type Doc = Record<string, unknown>;
export type SlackMethod =
  | 'auth.test'
  | 'rtm.connect'
  | 'users.conversations'
  | 'conversations.history'
  | 'conversations.replies'
  | 'users.info'
  | 'bots.info'
  | 'client.counts';
export type SlackArgs = Record<string, string | number | boolean | readonly unknown[] | Doc | undefined>;

const API = 'https://slack.com/api/';

/** What `openSocket` needs from a WebSocket: the upgrade must carry the session cookie. */
export type CreateRtmSocket = (url: string, headers: Record<string, string>) => import('../../lib/ddp.ts').WebSocketLike;

/** Slack's message servers: a `wss:` URL on one of its own hosts, nothing else gets the cookie. */
export function rtmUrl(raw: unknown): string {
  let url: URL;
  try { url = new URL(text(raw)); } catch { throw new SlackError('invalid_rtm_url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || !/^([a-z0-9-]+\.)+(slack-msgs\.com|slack\.com)$/.test(host))
    throw new SlackError('invalid_rtm_url');
  return url.href;
}
/** The envelopes that refuse the session itself; any other failure is the method's or the network's. */
export const SESSION_REJECTIONS: ReadonlySet<string> = new Set(['not_authed', 'invalid_auth', 'token_expired', 'token_revoked', 'account_inactive']);
const CODES = new Set([
  ...SESSION_REJECTIONS,
  'missing_scope', 'not_allowed_token_type', 'no_permission', 'channel_not_found', 'not_in_channel', 'org_login_required',
  'ratelimited', 'user_not_found', 'bot_not_found', 'thread_not_found', 'invalid_cursor', 'unknown_method', 'method_deprecated',
]);
const MAX_RESPONSE = 2_000_000;
const MAX_RETRY_WAIT_MS = 30_000;

export class SlackError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(code: string, status = 0, retryAfter: number | null = null) {
    super('Slack: ' + code); this.name = 'SlackError'; this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
  /** Only a Slack envelope refuses the session: HTML, proxies, TLS or 5xx never do. */
  get rejectsSession(): boolean { return SESSION_REJECTIONS.has(this.code); }
}

export function validateCredentials(token: string, cookie: string): void {
  if (!/^xoxc-[A-Za-z0-9-]+$/.test(token) || token.length > 16384 || !cookie.startsWith('xoxd-') || cookie.length <= 5 || cookie.length > 16384 || /[^\x21-\x7e]|[;,"\\]/.test(cookie))
    throw new SlackError('invalid_credentials');
}
export function record(value: unknown): Doc {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SlackError('invalid_response');
  return value as Doc;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,12}\.\d{6}$/.test(value);
}
export function exactTimestamp(value: unknown): string {
  if (!isTimestamp(value)) throw new SlackError('invalid_timestamp');
  return value;
}
export function compareTimestamp(a: string, b: string): number {
  const [as, af] = exactTimestamp(a).split('.'), [bs, bf] = exactTimestamp(b).split('.');
  const ai = BigInt(as), bi = BigInt(bs);
  return ai < bi ? -1 : ai > bi ? 1 : af < bf ? -1 : af > bf ? 1 : 0;
}
/** Display and order only: identity stays the exact string. */
export function timestampMs(ts: string): number {
  const [seconds, micros] = exactTimestamp(ts).split('.');
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}
/** The last microsecond of a millisecond, for an inclusive `latest`. */
export function latestOfMs(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}999`;
}
/** The first microsecond of a millisecond, for an inclusive `oldest`. */
export function oldestOfMs(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000`;
}
function cursor(body: Doc): string | null {
  if (body.response_metadata == null) return null;
  const next = record(body.response_metadata).next_cursor;
  if (next == null || next === '') return null;
  if (typeof next !== 'string' || next.length > 4096) throw new SlackError('invalid_response');
  return next;
}
function form(args: SlackArgs): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    out.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return out.toString();
}

export type SlackClientOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** The team and user the credentials were issued for, when known: any other identity is refused. */
  expected?: SlackAccount | null;
  /** Called once when Slack refuses the session, like Rocket.Chat's 401. */
  onRejected?: () => void;
};

export class SlackClient {
  #token: string;
  #cookie: string;
  #identity: SlackIdentity | null = null;
  #requests = new Set<AbortController>();
  #closed = false;
  #rejected = false;
  readonly #expected: SlackAccount | null;
  readonly #fetcher: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #onRejected: (() => void) | null;

  constructor(token: string, cookie: string, options: SlackClientOptions = {}) {
    validateCredentials(token, cookie);
    this.#token = token; this.#cookie = cookie;
    this.#expected = options.expected ?? null;
    this.#fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#onRejected = options.onRejected ?? null;
  }

  get identity(): SlackIdentity | null { return this.#identity; }

  close(): void {
    this.#closed = true; this.#token = ''; this.#cookie = ''; this.#identity = null;
    for (const request of this.#requests) request.abort();
  }

  /** A rate limit is retried once, after `Retry-After` capped at 30 s. */
  async call(method: SlackMethod, args: SlackArgs = {}): Promise<Doc> {
    try {
      return await this.#once(method, args);
    } catch (error) {
      if (!(error instanceof SlackError) || error.code !== 'ratelimited' || this.#closed) throw error;
      await this.#sleep(Math.min((error.retryAfter ?? 1) * 1000, MAX_RETRY_WAIT_MS));
      return this.#once(method, args);
    }
  }

  async #once(method: SlackMethod, args: SlackArgs): Promise<Doc> {
    if (this.#closed) throw new SlackError('cancelled');
    const controller = new AbortController(); this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetcher(API + method, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + this.#token, Cookie: 'd=' + this.#cookie, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form(args),
      });
      // React Native's fetch ignores `redirect`: a followed redirect shows in the final URL.
      if (response.redirected || (response.url !== '' && response.url !== API + method)) throw new SlackError('redirected', response.status);
      const retry = response.headers.get('retry-after');
      const retryAfter = retry !== null && /^\d+$/.test(retry) ? Number(retry) : null;
      if (response.status === 429) throw new SlackError('ratelimited', 429, retryAfter);
      if (!response.ok) throw new SlackError('http_error', response.status);
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE) throw new SlackError('response_too_large');
      let body: Doc;
      try { body = record(JSON.parse(raw)); } catch { throw new SlackError('invalid_response'); }
      if (body.ok === false) {
        const error = new SlackError(CODES.has(text(body.error)) ? text(body.error) : 'api_error', response.status, retryAfter);
        if (error.rejectsSession && !this.#closed && !this.#rejected) {
          this.#rejected = true;
          this.#onRejected?.();
        }
        throw error;
      }
      if (body.ok !== true) throw new SlackError('invalid_response');
      if (this.#closed) throw new SlackError('cancelled');
      return body;
    } catch (error) {
      if (error instanceof SlackError) throw error;
      throw new SlackError(this.#closed ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'connection_failed');
    } finally { clearTimeout(timer); this.#requests.delete(controller); }
  }

  async authenticate(): Promise<SlackIdentity> {
    const body = await this.call('auth.test');
    const teamId = text(body.team_id), userId = text(body.user_id);
    if (this.#expected && (this.#expected.teamId !== teamId || this.#expected.userId !== userId)) { this.close(); throw new SlackError('identity_mismatch'); }
    let url: URL;
    try { url = new URL(text(body.url)); } catch { throw new SlackError('invalid_identity'); }
    if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[UW][A-Z0-9]+$/.test(userId) || url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/')
      throw new SlackError('invalid_identity');
    if (this.#identity && (this.#identity.teamId !== teamId || this.#identity.userId !== userId)) throw new SlackError('identity_changed');
    this.#identity = { key: 'slack:' + teamId + ':' + userId, teamId, userId, team: text(body.team) || teamId, user: text(body.user) || userId, origin: url.origin };
    return this.#identity;
  }

  /**
   * `rtm.connect`, then the socket it names, opened with the session cookie on
   * the upgrade and no bearer. The URL is checked to be Slack's and the
   * identity the account's before anything is opened.
   */
  async openSocket(create: CreateRtmSocket): Promise<import('../../lib/ddp.ts').WebSocketLike> {
    const body = await this.call('rtm.connect', { batch_presence_aware: 1, presence_sub: true });
    const team = text(record(body.team ?? {}).id), self = text(record(body.self ?? {}).id);
    const expected = this.#identity ?? (this.#expected ? { teamId: this.#expected.teamId, userId: this.#expected.userId } : null);
    if (expected !== null && (team !== expected.teamId || self !== expected.userId)) throw new SlackError('identity_mismatch');
    const url = rtmUrl(body.url);
    if (this.#closed) throw new SlackError('cancelled');
    return create(url, { Cookie: 'd=' + this.#cookie });
  }

  /** One page of a cursor-paged list kept under `key`. */
  async page(method: SlackMethod, args: SlackArgs, key: string, next?: string | null): Promise<SlackPage<Doc>> {
    const body = await this.call(method, { ...args, ...(next ? { cursor: next } : {}) });
    const list = body[key];
    if (!Array.isArray(list)) throw new SlackError('invalid_response');
    const nextCursor = cursor(body);
    if (body.has_more === true && nextCursor === null) throw new SlackError('pagination_unsupported');
    return { items: list.map(record), nextCursor };
  }

  /** Every page; a cursor seen twice is a loop, never a silent truncation. */
  async pages(method: SlackMethod, args: SlackArgs, key: string, maxPages = 100): Promise<Doc[]> {
    const out: Doc[] = [];
    const seen = new Set<string>();
    let next: string | null = null;
    for (let n = 0; n < maxPages; n++) {
      const page = await this.page(method, args, key, next);
      out.push(...page.items);
      if (page.nextCursor === null) return out;
      if (seen.has(page.nextCursor)) throw new SlackError('pagination_loop');
      seen.add(page.nextCursor);
      next = page.nextCursor;
    }
    throw new SlackError('pagination_limit');
  }
}
