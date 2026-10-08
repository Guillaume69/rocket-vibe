/**
 * Mattermost REST v4 transport: `Authorization: Bearer`, JSON bodies, error
 * envelope `{id, message, status_code}`. Pure: `fetch` and the sleep are
 * injected so the module runs under Node.
 */

export type MmQuery = Record<string, string | number | boolean | undefined>;

export type MmRequest = {
  query?: MmQuery;
  body?: unknown;
  signal?: AbortSignal;
  /** No token at all (login): a 401 there never revokes the session. */
  anonymous?: boolean;
  /** Token sent, but a 401 is the caller's to judge (resume, token check, another account's badge). */
  quiet?: boolean;
  headers?: Record<string, string>;
};

export const MM_PAGE = 200;

export class MmError extends Error {
  readonly status: number;
  /** Mattermost's translation key, e.g. `api.context.session_expired.app_error`. */
  readonly id: string | null;

  constructor(status: number, id: string | null, message: string) {
    super(message);
    this.name = 'MmError';
    this.status = status;
    this.id = id;
  }
}

export type MmClientOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Called with the rejected token when an authenticated request answers 401. */
  onTokenRejected?: (token: string) => void;
  /**
   * kChat's errors are `{message}` without Mattermost's `id` (probed: a revoked
   * token answers `401 {"message": "Unauthorized"}`): a JSON body with a
   * `message` is then enough to believe the status.
   */
  plainErrors?: boolean;
};

const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_ATTEMPTS = 3;

export class MmClient {
  readonly baseUrl: string;
  token: string | null;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly onTokenRejected: ((token: string) => void) | null;
  private readonly plainErrors: boolean;

  constructor(baseUrl: string, token: string | null, options: MmClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.onTokenRejected = options.onTokenRejected ?? null;
    this.plainErrors = options.plainErrors ?? false;
  }

  url(path: string, query?: MmQuery): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return `${this.baseUrl}/api/v4${path}${suffix}`;
  }

  get<T>(path: string, options: MmRequest = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  /** A list route read page after page until a short one. */
  async pages<T>(path: string, options: MmRequest = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; ; page++) {
      const batch = await this.get<unknown>(path, { ...options, query: { ...options.query, page, per_page: MM_PAGE } });
      if (!Array.isArray(batch)) return out;
      out.push(...(batch as T[]));
      if (batch.length < MM_PAGE) return out;
    }
  }

  post<T>(path: string, options: MmRequest = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  put<T>(path: string, options: MmRequest = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  delete<T>(path: string, options: MmRequest = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /** Same call, but the response headers too (the login token travels in `Token`). */
  async requestWithHeaders<T>(
    method: string,
    path: string,
    options: MmRequest = {},
  ): Promise<{ body: T; headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.send(method, path, options);
      if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
        await this.sleep(rateLimitWait(response.headers));
        continue;
      }
      const text = await response.text().catch(() => '');
      const parsed = parseJson(text);
      if (response.ok) return { body: parsed as T, headers: response.headers };
      const envelope = isRecord(parsed) ? parsed : {};
      const id = typeof envelope.id === 'string' ? envelope.id : null;
      const message = typeof envelope.message === 'string' ? envelope.message : `HTTP ${response.status}`;
      const understood = id !== null || (this.plainErrors && typeof envelope.message === 'string');
      if (response.status === 401 && !options.anonymous && !options.quiet && this.token !== null && understood) {
        this.onTokenRejected?.(this.token);
      }
      throw new MmError(response.status, id, message);
    }
  }

  /** A form POST outside `/api/v4` (kChat's `/broadcasting/auth`). */
  async postForm<T>(absoluteUrl: string, fields: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(absoluteUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(this.token !== null ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (e) {
      throw new MmError(0, null, e instanceof Error ? e.message : 'Network unreachable');
    }
    const parsed = parseJson(await response.text().catch(() => ''));
    if (!response.ok) {
      if (response.status === 401 && this.token !== null) this.onTokenRejected?.(this.token);
      throw new MmError(response.status, null, `HTTP ${response.status}`);
    }
    return parsed as T;
  }

  async request<T>(method: string, path: string, options: MmRequest = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, options)).body;
  }

  private async send(method: string, path: string, options: MmRequest): Promise<Response> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(this.url(path, options.query), {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token !== null && !options.anonymous ? { Authorization: `Bearer ${this.token}` } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (e) {
      throw new MmError(0, null, e instanceof Error ? e.message : 'Network unreachable');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
    }
  }
}

/**
 * `X-Ratelimit-Reset` is in SECONDS until the window resets. Capped like the
 * Rocket.Chat client, so a misconfigured proxy cannot freeze the app.
 */
function rateLimitWait(headers: Headers): number {
  const reset = Number(headers.get('x-ratelimit-reset'));
  const ms = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000;
  return Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mmErrorId(error: unknown): string | null {
  return error instanceof MmError ? error.id : null;
}
