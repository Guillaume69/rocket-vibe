/**
 * Probes a Rocket.Chat server **without authentication**.
 *
 * `GET /api/info` and `GET /api/v1/settings.public` are open and are enough to
 * discover the version, the enabled authentication methods and the settings
 * that change client behaviour. The login screen does this before showing
 * anything.
 *
 * Transport comes from `RestClient` (timeout, cancellation, defensive JSON,
 * retry on 429), **including `/api/info`**, which does not live under
 * `/api/v1/` and so goes through the `outsideApiV1` option. It used to be left
 * out, on a bare `fetch`: a request left hanging (reverse proxy, captive
 * portal) left the `Promise.all` below hanging forever, so the login screen
 * dead and silent, its `inFlight` guard armed for good.
 */

import { RestClient, type Dependencies, RestError } from './rest.ts';

export type TwoFactor = {
  active: boolean;
  totp: boolean;
  email: boolean;
};

export type ServerProfile = {
  /** The URL normalized by `normalizeUrl`: the one the probe actually
   * queried. The caller builds its client on it, rather than re-normalizing
   * the input on its side and risking another host. */
  baseUrl: string;
  version: string;
  siteUrl: string | null;
  loginForm: boolean;
  twoFactor: TwoFactor;
  ldap: boolean;
  oauth: string[];
  e2eeEnabled: boolean;
  filesProtected: boolean;
  avatarsProtected: boolean;
};

/** The `value` field of `settings.public` is heterogeneous: it is not constrained. */
type PublicSetting = { _id: string; value: unknown };

export class ServerError extends Error {
  readonly origin?: unknown;

  constructor(message: string, origin?: unknown) {
    super(message);
    this.name = 'ServerError';
    this.origin = origin;
  }
}

/**
 * Accepts "chat.example.com", "http://192.168.1.106:3000" or a URL with a
 * trailing slash. Without a scheme, `https://` is assumed.
 *
 * The **sub-path is kept**: a Rocket.Chat served behind a reverse proxy often
 * lives under `/chat`, and `new URL(...).origin` would drop it.
 */
export function normalizeUrl(entry: string): string {
  const raw = entry.trim();
  if (raw === '') throw new ServerError('Empty address.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (e) {
    throw new ServerError(`Invalid address: ${raw}`, e);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function indexSettings(payload: unknown): Map<string, unknown> {
  const settings = (payload as { settings?: unknown } | null)?.settings;
  if (!Array.isArray(settings)) {
    throw new ServerError('`settings.public` has no `settings` array.');
  }
  const index = new Map<string, unknown>();
  for (const raw of settings as PublicSetting[]) {
    if (typeof raw?._id === 'string') index.set(raw._id, raw.value);
  }
  return index;
}

const trueIf = (v: unknown): boolean => v === true;

/**
 * `/api/info` lives outside `/api/v1/`, hence `outsideApiV1`, but that way it
 * inherits the maximum timeout, cancellation relay, retry on 429 and
 * defensive parsing. Unauthenticated, it returns `{version: '8.5', success:
 * true}` on 8.5.1: the MINOR version only, shown at login.
 */
async function fetchVersion(
  client: RestClient,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await client.get<{ version?: unknown }>('api/info', {
    anonymous: true,
    outsideApiV1: true,
    signal,
  });
  if (typeof payload.version !== 'string') {
    throw new ServerError('The response does not look like a Rocket.Chat one.');
  }
  return payload.version;
}

export async function probeServer(
  entry: string,
  signal?: AbortSignal,
  /** Same seam as `RestClient`: tests exercise the timeout without sleeping. */
  dep?: Partial<Dependencies>,
): Promise<ServerProfile> {
  const base = normalizeUrl(entry);
  const client = new RestClient(base, dep);

  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);
  if (signal?.aborted) controller.abort();

  try {
    // The two calls are independent: chaining them would double the latency.
    // `count=0` disables pagination, otherwise only one page comes back.
    const pVersion = fetchVersion(client, controller.signal);
    const settingsPromise = client.get<unknown>('settings.public', {
      params: { count: 0 },
      anonymous: true,
      signal: controller.signal,
    });
    pVersion.catch(() => {});
    settingsPromise.catch(() => {});

    let version: string;
    let rawSettings: unknown;
    try {
      [version, rawSettings] = await Promise.all([pVersion, settingsPromise]);
    } catch (e) {
      controller.abort(); // Do not leave the sibling request lingering.
      if (e instanceof ServerError) throw e;
      if (e instanceof RestError) throw new ServerError(e.message, e);
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ServerError('Server unreachable.', e);
    }

    const settings = indexSettings(rawSettings);

    const oauth = [...settings.entries()]
      .filter(([key, value]) => key.startsWith('Accounts_OAuth_') && value === true)
      .map(([key]) => key.replace('Accounts_OAuth_', ''));

    const siteUrl = settings.get('Site_Url');

    return {
      baseUrl: base,
      version,
      siteUrl: typeof siteUrl === 'string' ? siteUrl : null,
      loginForm: trueIf(settings.get('Accounts_ShowFormLogin')),
      twoFactor: {
        active: trueIf(settings.get('Accounts_TwoFactorAuthentication_Enabled')),
        totp: trueIf(settings.get('Accounts_TwoFactorAuthentication_By_TOTP_Enabled')),
        email: trueIf(settings.get('Accounts_TwoFactorAuthentication_By_Email_Enabled')),
      },
      ldap: trueIf(settings.get('LDAP_Enable')),
      oauth,
      e2eeEnabled: trueIf(settings.get('E2E_Enable')),
      filesProtected: trueIf(settings.get('FileUpload_ProtectFiles')),
      avatarsProtected: trueIf(settings.get('Accounts_AvatarBlockUnauthenticatedAccess')),
    };
  } finally {
    signal?.removeEventListener('abort', relay);
  }
}
