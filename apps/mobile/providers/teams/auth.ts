/**
 * A Teams account: signed in with a Microsoft device code as the Teams
 * desktop app's public client, kept by its refresh token, which Microsoft
 * rotates on every refresh. Access and Skype tokens live in memory only.
 * Mirrors `apps/desktop/crates/rv-core/src/teams/auth.rs`.
 */

import type { Session } from '../../lib/auth.ts';

/** The Teams desktop and mobile app: a public client, so a device code completes. */
export const TEAMS_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
const LOGIN = 'https://login.microsoftonline.com';
const SPACES = 'https://api.spaces.skype.com';
const PRESENCE = 'https://presence.teams.microsoft.com';
const SUBSTRATE = 'https://substrate.office.com';
const AGGREGATOR = 'https://chatsvcagg.teams.microsoft.com';
const GRAPH = 'https://graph.microsoft.com';
/** Teams' templates service, which renames a channel (verified 2026-10-23). */
const TEMPLATES = 'https://templates.teams.microsoft.com';
const AUTHZ = 'https://teams.microsoft.com/api/authsvc/v1.0/authz';
/** The `baseUrl` of every Teams account: its services live behind routes discovered per tenant. */
export const TEAMS_ORIGIN = 'https://teams.microsoft.com';
const MARGIN_MS = 5 * 60_000;

export class TeamsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(code: string, status = 0, retryAfter: number | null = null) {
    super(`Teams: ${code}`);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
  /** Only Microsoft refusing the refresh token, or the services refusing a fresh token, ends the session. */
  get rejectsSession(): boolean {
    return this.status === 401;
  }
}

export type TeamsOptions = { fetch?: typeof fetch; onSkype?: (skype: string, routes: TeamsRoutes) => void };

function guid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function form(url: string, fields: Record<string, string>, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  } catch {
    throw new TeamsError('network');
  }
  if (response.status >= 500) throw new TeamsError('server', response.status);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new TeamsError('invalid_answer', response.status);
  }
}

/** The claims of an id token Microsoft just handed us over TLS: read, not verified. */
export function idClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type DeviceCode = { userCode: string; verificationUri: string; expiresIn: number; interval: number; deviceCode: string };

export async function deviceCode(options: TeamsOptions = {}): Promise<DeviceCode> {
  const body = await form(`${LOGIN}/organizations/oauth2/v2.0/devicecode`, { client_id: TEAMS_CLIENT_ID, scope: `${SPACES}/.default openid profile offline_access` }, options.fetch ?? fetch);
  const text = (key: string) => (typeof body[key] === 'string' && body[key] !== '' ? (body[key] as string) : null);
  const userCode = text('user_code'), code = text('device_code'), uri = text('verification_uri');
  if (!userCode || !code || !uri?.startsWith('https://')) throw new TeamsError('device_code');
  return {
    userCode,
    deviceCode: code,
    verificationUri: uri,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 900,
    interval: Math.min(60, Math.max(1, typeof body.interval === 'number' ? body.interval : 5)),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the code is approved, refused or expired; `cancelled` ends it early. */
export async function approved(code: DeviceCode, cancelled: () => boolean, options: TeamsOptions = {}): Promise<Session> {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + code.expiresIn * 1000;
  let interval = code.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    if (cancelled()) throw new TeamsError('cancelled');
    const body = await form(`${LOGIN}/organizations/oauth2/v2.0/token`, {
      client_id: TEAMS_CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.deviceCode,
    }, fetcher);
    switch (body.error) {
      case 'authorization_pending': continue;
      case 'slow_down': interval += 5; continue;
      case 'authorization_declined': throw new TeamsError('declined');
      case 'expired_token': throw new TeamsError('expired');
      case undefined: return signedIn(body, options);
      default: throw new TeamsError(String(body.error));
    }
  }
  throw new TeamsError('expired');
}

async function signedIn(body: Record<string, unknown>, options: TeamsOptions): Promise<Session> {
  const claims = idClaims(body.id_token);
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!claims || refresh === '' || !guid(claims.tid) || !guid(claims.oid)) throw new TeamsError('id_token');
  const name = typeof claims.name === 'string' && claims.name ? claims.name
    : typeof claims.preferred_username === 'string' && claims.preferred_username ? claims.preferred_username : claims.oid;
  const session: Session = {
    baseUrl: TEAMS_ORIGIN,
    authToken: '',
    userId: `8:orgid:${claims.oid}`,
    username: name,
    kind: 'teams',
    siteUrl: null,
    teamsTenantId: claims.tid,
    teamsRefresh: refresh,
  };
  await new TeamsTokens(session, options).chat();
  return session;
}

/** A stored Teams session, refused unless every field is one Microsoft could have given. */
export function validTeamsSession(session: Session): boolean {
  return session.baseUrl === TEAMS_ORIGIN && guid(session.teamsTenantId) && typeof session.teamsRefresh === 'string'
    && session.teamsRefresh !== '' && guid(session.userId.replace(/^8:orgid:/, '')) && session.userId.startsWith('8:orgid:');
}

let sink: ((session: Session) => void) | null = null;
/** Where a rotated refresh token is saved: the app's secure store, set once. */
export function setTeamsCredentialSink(fn: (session: Session) => void): void {
  sink = fn;
}

/** The routes authz hands a tenant; only `https` Teams and Trouter hosts are kept. */
export type TeamsRoutes = { chat: string; aggregator: string; trouter: string; registrar: string; ams: string; middleTier: string; presence: string; search: string };

function onHosts(raw: unknown, suffixes: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const ok = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && suffixes.some((s) => host === s.slice(1) || host.endsWith(s));
  return ok ? raw.replace(/\/+$/, '') : null;
}

const TEAMS_HOSTS = ['.teams.microsoft.com', '.teams.cloud.microsoft'] as const;

export function discoverRoutes(body: Record<string, unknown>): TeamsRoutes | null {
  const gtms = (body.regionGtms ?? {}) as Record<string, unknown>;
  const chat = onHosts(gtms.chatServiceAfd, TEAMS_HOSTS), aggregator = onHosts(gtms.chatSvcAggAfd, TEAMS_HOSTS);
  if (!chat || !aggregator) return null;
  return {
    chat,
    aggregator,
    trouter: onHosts(gtms.calling_trouterUrl, ['.trouter.teams.microsoft.com']) ?? '',
    registrar: onHosts(gtms.calling_registrarUrl, TEAMS_HOSTS) ?? '',
    ams: onHosts(gtms.ams, ['.asyncgw.teams.microsoft.com', '.teams.microsoft.com']) ?? '',
    middleTier: onHosts(gtms.middleTier, TEAMS_HOSTS) ?? '',
    presence: onHosts(gtms.unifiedPresence, TEAMS_HOSTS) ?? '',
    search: onHosts(gtms.search, ['.asyncgw.teams.microsoft.com', '.teams.microsoft.com']) ?? '',
  };
}

type Lease = { value: string; until: number };
const fresh = (lease: Lease | null) => (lease && Date.now() + MARGIN_MS < lease.until ? lease.value : null);

/** An account's live tokens, refreshed from the refresh token near their end. */
export class TeamsTokens {
  private session: Session;
  private readonly fetcher: typeof fetch;
  private aggregatorLease: Lease | null = null;
  private skypeLease: Lease | null = null;
  private spacesLease: Lease | null = null;
  private presenceLease: Lease | null = null;
  private substrateLease: Lease | null = null;
  private graphLease: Lease | null = null;
  private templatesLease: Lease | null = null;
  private routesHeld: TeamsRoutes | null = null;
  private pending = new Map<string, Promise<Lease>>();
  private readonly onSkype: TeamsOptions['onSkype'];

  constructor(session: Session, options: TeamsOptions = {}) {
    if (session.kind !== 'teams' || !session.teamsTenantId || !session.teamsRefresh) throw new TeamsError('not_teams');
    this.session = session;
    this.fetcher = options.fetch ?? fetch;
    this.onSkype = options.onSkype;
  }

  /** Tokens already held, for a test server: they never refresh. */
  static preset(session: Session, routes: TeamsRoutes, skype: string, aggregator: string, options: TeamsOptions = {}): TeamsTokens {
    const tokens = new TeamsTokens(session, options);
    const far = Date.now() + 365 * 86_400_000;
    tokens.routesHeld = routes;
    tokens.skypeLease = { value: skype, until: far };
    tokens.aggregatorLease = { value: aggregator, until: far };
    tokens.spacesLease = { value: aggregator, until: far };
    return tokens;
  }

  get current(): Session {
    return this.session;
  }

  private access(audience: string): Promise<Lease> {
    const running = this.pending.get(audience);
    if (running) return running;
    const work = (async () => {
      const body = await form(`${LOGIN}/${this.session.teamsTenantId}/oauth2/v2.0/token`, {
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this.session.teamsRefresh ?? '',
        scope: `${audience}/.default openid profile offline_access`,
      }, this.fetcher);
      if (typeof body.error === 'string') {
        throw new TeamsError(body.error, ['invalid_grant', 'interaction_required', 'invalid_client'].includes(body.error) ? 401 : 400);
      }
      if (typeof body.access_token !== 'string' || body.access_token === '') throw new TeamsError('access_token');
      if (typeof body.refresh_token === 'string' && body.refresh_token !== '' && body.refresh_token !== this.session.teamsRefresh) {
        this.session = { ...this.session, teamsRefresh: body.refresh_token };
        sink?.(this.session);
      }
      const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      return { value: body.access_token, until: Date.now() + seconds * 1000 };
    })().finally(() => this.pending.delete(audience));
    this.pending.set(audience, work);
    return work;
  }

  async aggregator(): Promise<string> {
    const held = fresh(this.aggregatorLease);
    if (held) return held;
    this.aggregatorLease = await this.access(AGGREGATOR);
    return this.aggregatorLease.value;
  }

  /** The Spaces bearer: authz and the middle tier's profiles. */
  async spaces(): Promise<string> {
    const held = fresh(this.spacesLease);
    if (held) return held;
    this.spacesLease = await this.access(SPACES);
    return this.spacesLease.value;
  }

  /** The presence bearer: the Unified Presence Service wants an AAD token for
   *  its own scope, not the skypetoken (probed live 2026-10-22). */
  async presence(): Promise<string> {
    const held = fresh(this.presenceLease);
    if (held) return held;
    this.presenceLease = await this.access(PRESENCE);
    return this.presenceLease.value;
  }

  /** The Substrate bearer, for message search. */
  async substrate(): Promise<string> {
    const held = fresh(this.substrateLease);
    if (held) return held;
    this.substrateLease = await this.access(SUBSTRATE);
    return this.substrateLease.value;
  }

  /** The Microsoft Graph bearer, for file download (SharePoint/OneDrive drive
   *  items). Minted from the same refresh token through the Teams first-party
   *  client's pre-consent; carries Files.ReadWrite.All but not Chat.*. */
  async graph(): Promise<string> {
    const held = fresh(this.graphLease);
    if (held) return held;
    this.graphLease = await this.access(GRAPH);
    return this.graphLease.value;
  }

  /** The templates bearer, for renaming a channel. */
  async templates(): Promise<string> {
    const held = fresh(this.templatesLease);
    if (held) return held;
    this.templatesLease = await this.access(TEMPLATES);
    return this.templatesLease.value;
  }

  forgetTemplates(): void {
    this.templatesLease = null;
  }

  /** The Skype token and the tenant's routes, from authz. */
  async chat(): Promise<{ skype: string; routes: TeamsRoutes }> {
    const held = fresh(this.skypeLease);
    if (held && this.routesHeld) return { skype: held, routes: this.routesHeld };
    const spaces = await this.spaces();
    let response: Response;
    try {
      response = await this.fetcher(AUTHZ, { method: 'POST', headers: { authorization: `Bearer ${spaces}`, 'content-length': '0' } });
    } catch {
      throw new TeamsError('network');
    }
    if (response.status === 401 || response.status === 403) throw new TeamsError('authz', 401);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const tokens = (body.tokens ?? {}) as Record<string, unknown>;
    const routes = discoverRoutes(body);
    if (typeof tokens.skypeToken !== 'string' || tokens.skypeToken === '' || !routes) throw new TeamsError('authz', response.status);
    const seconds = typeof tokens.expiresIn === 'number' ? tokens.expiresIn : 3600;
    this.skypeLease = { value: tokens.skypeToken, until: Date.now() + seconds * 1000 };
    this.routesHeld = routes;
    this.onSkype?.(tokens.skypeToken, routes);
    return { skype: tokens.skypeToken, routes };
  }

  forgetChat(): void {
    this.skypeLease = null;
  }

  forgetAggregator(): void {
    this.aggregatorLease = null;
  }
}

/** Proves a stored account still signs in; answers it with its newest refresh token. */
export async function resumeTeams(session: Session, options: TeamsOptions = {}): Promise<Session> {
  if (!validTeamsSession(session)) throw new TeamsError('invalid_session', 401);
  const tokens = new TeamsTokens(session, options);
  await tokens.chat();
  return tokens.current;
}
