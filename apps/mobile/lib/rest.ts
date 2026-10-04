/**
 * Rocket.Chat REST client.
 *
 * Deliberately **no `react-native` import**: this module runs as is under
 * Node, so its tests run against real HTTP servers rather than mocks.
 * Everything platform-related (secure storage, `Platform.OS`) lives elsewhere.
 *
 * We act over REST and listen over DDP: DDP method calls are deprecated since
 * Rocket.Chat 8.0, with removal announced for 9.0.
 */

export type RestAuth = {
  authToken: string;
  userId: string;
};

/** Methods of Rocket.Chat's generic 2FA mechanism. */
export type TwoFactorMethod = 'totp' | 'email' | 'password';

export type TwoFactorCode = {
  code: string;
  method: TwoFactorMethod;
};

export class RestError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly errorType?: string;
  /**
   * The body was read as a **Rocket.Chat** response (`success`/`error`
   * envelope), not as an opaque page.
   *
   * That is what separates "the application server answers us" from
   * "something on the path answers us": a corporate proxy, a captive portal or
   * a maintenance page can return a 401 in HTML. Its status is ITS OWN: it
   * says nothing about our token, and taking it for a revocation would eject
   * the user from a perfectly valid session.
   */
  readonly understoodResponse: boolean;

  constructor(
    message: string,
    status: number,
    error?: string,
    errorType?: string,
    understoodResponse = false,
  ) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.error = error;
    this.errorType = errorType;
    this.understoodResponse = understoodResponse;
  }
}

/**
 * Thrown when the server requires a second authentication.
 *
 * The name `totp-required` is misleading: it also covers `email` and
 * `password`. The method actually expected is in `details.method`. For
 * `password`, the code is the **SHA-256 of the password**, never the plain
 * password.
 */
export class TwoFactorError extends RestError {
  readonly method: TwoFactorMethod;
  readonly availableMethods: TwoFactorMethod[];
  readonly generatedCode: boolean;

  constructor(
    method: TwoFactorMethod,
    availableMethods: TwoFactorMethod[],
    generatedCode: boolean,
  ) {
    // `understoodResponse` really is TRUE: a 2FA challenge is a proper
    // Rocket.Chat response, read as such. What sets it apart from a revocation
    // is its TYPE, not a reading failure, and that is what makes the predicate's
    // `instanceof` guard load-bearing rather than decorative. The 401 declared
    // here does not reflect the HTTP status: outside login, 8.5 answers 400.
    super(`Two-factor authentication required (${method})`, 401, undefined, 'totp-required', true);
    this.name = 'TwoFactorError';
    this.method = method;
    this.availableMethods = availableMethods;
    this.generatedCode = generatedCode;
  }
}

/**
 * "Did the server reject THIS token?"
 *
 * The only predicate allowed to trigger an automatic logout. It is
 * deliberately as narrow as possible: a misclassification ejects the user from
 * a healthy session, which is worse than the defect being fixed.
 *
 * Probed against a Rocket.Chat 8.5 (local bench, 30/07/2026), the server is
 * clear: **401 means "not authenticated", and nothing else**:
 *
 * | situation                                   | response |
 * |---------------------------------------------|----------|
 * | token revoked by `logout`                   | **401** `You must be logged in to do this.` |
 * | missing token, bogus token, bogus uid       | **401**, same body |
 * | missing permission (admin route)            | 403 `error-unauthorized` |
 * | removed from the room, room not found       | 400 `error-not-allowed` / `error-room-not-found` |
 * | 2FA required on a sensitive operation       | 400 `totp-required` |
 *
 * Hence the three conditions, each closing a real false positive:
 *
 * 1. `RestError` with status 401: the nominal case;
 * 2. **not** a `TwoFactorError`: it declares itself 401 whatever the HTTP
 *    response (the server answers 400 outside login), and it is a challenge,
 *    not a refusal. Treating it as a revocation would log out anyone changing
 *    their password;
 * 3. `understoodResponse`: a 401 whose body is not Rocket.Chat comes from an
 *    intermediary, not the server.
 *
 * What the predicate does NOT say: whether this token is still the one of the
 * displayed session. That comparison belongs to the caller, the only one that
 * knows the token actually sent (see `onTokenRejected`).
 */
export function isTokenRejected(e: unknown): boolean {
  if (e instanceof TwoFactorError) return false;
  if (!(e instanceof RestError)) return false;
  return e.status === 401 && e.understoodResponse;
}

export type RequestOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  twoFactor?: TwoFactorCode;
  /** Skip authentication (login, settings.public...). */
  anonymous?: boolean;
  /**
   * Replay ONCE if the `fetch` fails at the network level (no HTTP response
   * received). Reserved for idempotent writes (profile, status): a request
   * rejected without a response delivered nothing, so replaying it doubles no
   * server effect. `chat.sendMessage` does NOT enable it: its deduplication
   * lives in lib/outbox, which keeps the "en-attente" row for a clean replay.
   */
  networkReplay?: boolean;
  /**
   * Path served OUTSIDE `/api/v1/`. A single case: `/api/info`, the only useful
   * Rocket.Chat route living at the root. Without this, it escaped this
   * module's whole defence (the maximum delay first) and could block the
   * login screen forever (see `lib/server.ts`).
   */
  outsideApiV1?: boolean;
};

/** Injectables for tests: no real sleep, no real clock. */
export type Dependencies = {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Retry spread. Injected so the delays stay testable. */
  random: () => number;
};

const TIMEOUT_MS = 15_000;
const ATTEMPTS_429 = 3;
/** A single replay on network failure: a dead keep-alive connection starts afresh. */
const NETWORK_ATTEMPTS = 1;
const NETWORK_RETRY_DELAY_MS = 400;
/**
 * Spread added to a 429 retry. Without it, two concurrent calls receive the
 * SAME `x-ratelimit-reset` and wake up on the same millisecond: they burst
 * back onto a window that has only just reopened, and get another 429. Same
 * reason as the reconnection driver's jitter (`lib/reconnect.ts`): a
 * thundering herd, with two heads.
 */
const JITTER_429_MS = 500;

type RocketChatResponse = {
  success?: boolean;
  error?: string;
  errorType?: string;
  message?: string;
  status?: string;
  details?: {
    method?: string;
    availableMethods?: string[];
    codeGenerated?: boolean;
  };
};

const METHODS: readonly TwoFactorMethod[] = ['totp', 'email', 'password'];

function isMethod(v: unknown): v is TwoFactorMethod {
  return typeof v === 'string' && (METHODS as readonly string[]).includes(v);
}

/** Same shape as `fetch`'s `AbortError`, without depending on `DOMException`. */
function cancelError(): Error {
  const e = new Error('Request canceled.');
  e.name = 'AbortError';
  return e;
}

export class ClientRest {
  readonly baseUrl: string;
  auth: RestAuth | null = null;

  /**
   * Called when the server rejects the token (`isTokenRejected`), with the
   * token **actually sent**, not the one current at reception.
   *
   * It is the only way to cover the whole running life without touching a
   * single call site: `catchUpGlobal`, `chat.syncMessages`, `chat.sendMessage`,
   * `users.presence`... all go through here. Without this hook, a token
   * revoked mid-session (password changed elsewhere, `Accounts_LoginExpiration`,
   * `logoutOtherClients`) left the app in a zombie state: yesterday's cache
   * shown, sync bar pulsing, every send failing; exactly what a network problem
   * looks like, and no way out before a restart.
   *
   * The token is passed so the subscriber can ignore a **late** 401 arriving on
   * an already replaced token (logout then login while the request was in
   * flight). `ClientRest` has no notion of session: it reports, it does not
   * decide.
   */
  onTokenRejected: ((token: string) => void) | null = null;

  private readonly dep: Dependencies;

  constructor(baseUrl: string, dep?: Partial<Dependencies>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dep = {
      fetch: dep?.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: dep?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: dep?.now ?? (() => Date.now()),
      random: dep?.random ?? Math.random,
    };
  }

  /**
   * Sleeps, but LISTENING for cancellation.
   *
   * `call()` removes its abort listener in its `finally`, so before the retry
   * sleep: an `abort()` during those seconds was only noticed on return from
   * recursion, up to 30 s later, 90 s total over three attempts. The promise
   * returned to the caller stayed pending that long, and its spinner with it.
   */
  private async cancelableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.dep.sleep(ms);
    if (signal.aborted) throw cancelError();
    let onAbort: () => void = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelError());
      signal.addEventListener('abort', onAbort);
    });
    try {
      await Promise.race([this.dep.sleep(ms), cancellation]);
    } finally {
      // Detached in every case: otherwise an `abort()` after waking up would
      // reject a promise nobody observes any more.
      signal.removeEventListener('abort', onAbort);
    }
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('POST', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('DELETE', path, options);
  }

  private buildUrl(path: string, options: RequestOptions): string {
    const prefix = options.outsideApiV1 === true ? '' : 'api/v1/';
    const url = new URL(`${this.baseUrl}/${prefix}${path}`);
    const params = options.params;
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(options: RequestOptions): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!options.anonymous && this.auth) {
      h['X-Auth-Token'] = this.auth.authToken;
      h['X-User-Id'] = this.auth.userId;
    }
    if (options.twoFactor) {
      h['x-2fa-code'] = options.twoFactor.code;
      h['x-2fa-method'] = options.twoFactor.method;
    }
    return h;
  }

  /**
   * Delay before retrying on 429. The server gives the reset time in epoch ms
   * in `x-ratelimit-reset`; failing that, exponential backoff. Capped: an
   * aberrant header must not freeze the app.
   *
   * The spread is added BEFORE the cap, so an aberrant header stays bounded
   * to 30 s.
   */
  private delayAfter429(response: Response, attempt: number): number {
    const raw = Number(response.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(raw) ? raw - this.dep.now() : 0;
    const delay = wait > 0 ? wait + 250 : 1000 * 2 ** attempt;
    return Math.min(delay + this.dep.random() * JITTER_429_MS, 30_000);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: RequestOptions,
    attempt = 0,
    networkAttempt = 0,
  ): Promise<T> {
    // An ALREADY aborted signal will never fire `addEventListener`, and the
    // request would still go out: test it before opening the connection.
    // Neither `AbortSignal.throwIfAborted` nor `DOMException` is guaranteed
    // under Hermes, hence the hand-built error.
    if (options.signal?.aborted) throw cancelError();

    // The token as it goes on the wire, captured BEFORE the request. Reading
    // it again at reception would give the CURRENT token: on a session
    // replaced mid-flight, a 401 carrying the old token would then present
    // itself under the new one, and erase a brand new session.
    const sentToken = options.anonymous === true ? null : (this.auth?.authToken ?? null);

    const controller = new AbortController();
    let expire = false;
    const timer = setTimeout(() => {
      expire = true;
      controller.abort();
    }, TIMEOUT_MS);
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay);

    let response: Response;
    try {
      response = await this.dep.fetch(this.buildUrl(path, options), {
        method,
        headers: this.headers(options),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (!expire) throw e; // Cancellation requested by the caller.
        throw new RestError(`${path}: no response within ${TIMEOUT_MS / 1000} s.`, 0);
      }
      // Network failure: the `fetch` rejected without an HTTP response. On
      // Android/OkHttp, the FIRST request after an idle period (here: the time
      // to fill in the form) sometimes reuses a dead keep-alive connection and
      // fails, where the next immediate send goes out on a fresh connection:
      // the classic "works the 2nd time". Nothing having been received from
      // the server, the request was (almost) never delivered: replaying it
      // doubles no effect, but we only do it if the caller asked.
      if (options.networkReplay && networkAttempt < NETWORK_ATTEMPTS) {
        // The `finally` clears timer and listener when the `return` is
        // evaluated; the recursion arms fresh ones. The 400 ms wait stays well
        // under the 15 s timeout, so the old timer does not fire meanwhile.
        await this.cancelableSleep(NETWORK_RETRY_DELAY_MS, options.signal);
        return this.call<T>(method, path, options, attempt, networkAttempt + 1);
      }
      throw new RestError(`${path}: server unreachable.`, 0);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
    }

    if (response.status === 429 && attempt < ATTEMPTS_429) {
      const delay = this.delayAfter429(response, attempt);
      await response.body?.cancel();
      await this.cancelableSleep(delay, options.signal);
      return this.call<T>(method, path, options, attempt + 1, networkAttempt);
    }

    // Read the text before parsing: a reverse proxy can return HTML with a
    // 200, and "invalid JSON" is not "server unreachable".
    const text = await response.text();

    // `POST /api/v1/logout` answers 200 with an EMPTY body, checked against an
    // 8.5 server. A success without content is not a format error.
    if (text.trim() === '' && response.ok) return {} as T;

    let json: RocketChatResponse & Record<string, unknown>;
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new RestError(
        `${path}: non-JSON response (${response.status}, ${text.length} bytes).`,
        response.status,
      );
    }

    // Rocket.Chat 8.5 signals 2FA in TWO shapes depending on the endpoint:
    //   /api/v1/login      -> { error: 'totp-required' }      (no errorType)
    //   /api/v1/settings/* -> { errorType: 'totp-required' }  (no error)
    // Checked against a real server. Testing only `errorType` let the login
    // 2FA surface as an ordinary RestError.
    if (json.errorType === 'totp-required' || json.error === 'totp-required') {
      const raw = json.details?.availableMethods ?? [];
      const requestedMethod = isMethod(json.details?.method) ? json.details.method : 'password';
      throw new TwoFactorError(
        requestedMethod,
        raw.filter(isMethod),
        json.details?.codeGenerated === true,
      );
    }

    // Rocket.Chat mixes two conventions: `success: false` on /api/v1/* and
    // `status: 'error'` on /api/v1/login. Both mean failure.
    if (!response.ok || json.success === false || json.status === 'error') {
      const message = json.error ?? json.message ?? `${path} failed`;
      // "JSON" is not enough to say "Rocket.Chat". An API gateway happily
      // answers `{"message":"Unauthorized"}` with a 401: it parses, and says
      // NOTHING about our token. So we require a mark of the house envelope;
      // that is what `understoodResponse` certifies.
      const rcEnvelope =
        typeof json.success === 'boolean' ||
        json.status === 'error' ||
        typeof json.errorType === 'string';
      const error = new RestError(
        message,
        response.status,
        json.error,
        json.errorType,
        rcEnvelope,
      );
      // Placed AFTER the `totp-required` branch (never on a 2FA challenge) and
      // AFTER the parse (never on a proxy's HTML 401). An `anonymous` call sent
      // no token: its 401 says nothing about the session.
      if (sentToken !== null && isTokenRejected(error)) this.onTokenRejected?.(sentToken);
      throw error;
    }

    return json as T;
  }
}
