/**
 * Mattermost and kChat sign-in.
 *
 * Mattermost: `POST /users/login`, the session token comes back in the `Token`
 * response header. Deliberately WITHOUT `X-Requested-With`: that header makes
 * the server set the `MMAUTHTOKEN` cookie, which React Native's cookie jar then
 * sends on every request, and the server reads the cookie BEFORE the bearer: a
 * `POST` without a CSRF token answers 401 `session_expired` (probed on 11.11),
 * indistinguishable from a real expiry. Media carry the bearer instead
 * (`lib/mediaAuth.ts`).
 *
 * kChat: no Mattermost login at all. An Infomaniak bearer token (OAuth access
 * token, or a personal API token) is sent as is to every kChat server of the
 * account, listed by `GET https://kchat.infomaniak.com/api/v4/users/me/servers`.
 */

import type { Session } from '../../lib/auth.ts';
import { originOf } from '../../lib/origin.ts';
import type { ProviderKind } from '../../lib/provider.ts';
import { MmClient, MmError } from './client.ts';
import { membershipCounts } from './translator.ts';

export const MFA_REQUIRED = 'mfa.validate_token.authenticate.app_error';
export const KCHAT_DIRECTORY = 'https://kchat.infomaniak.com';

export class MmMfaRequired extends Error {}

export type MmLoginOptions = { fetch?: typeof fetch };

export async function loginMattermost(
  baseUrl: string,
  user: string,
  password: string,
  mfaToken?: string,
  options: MmLoginOptions = {},
): Promise<Session> {
  const client = new MmClient(baseUrl, null, { fetch: options.fetch });
  try {
    const { body, headers } = await client.requestWithHeaders<Record<string, unknown>>('POST', '/users/login', {
      anonymous: true,
      body: { login_id: user.trim(), password, ...(mfaToken ? { token: mfaToken.trim() } : {}) },
    });
    const token = headers.get('token');
    if (token === null || typeof body.id !== 'string') throw new MmError(0, null, 'Login answer without a token.');
    return sessionFrom(client.baseUrl, token, body, 'mattermost');
  } catch (e) {
    if (e instanceof MmError && e.id === MFA_REQUIRED && !mfaToken) throw new MmMfaRequired('Second factor required.');
    throw e;
  }
}

/** A bearer token for a server: checked against `/users/me`, which names the account. */
export async function loginWithToken(
  baseUrl: string,
  token: string,
  kind: ProviderKind,
  options: MmLoginOptions = {},
): Promise<Session> {
  const client = new MmClient(baseUrl, token.trim(), { fetch: options.fetch });
  const me = await client.get<Record<string, unknown>>('/users/me', { quiet: true });
  return sessionFrom(client.baseUrl, token.trim(), me, kind);
}

export async function resumeMattermost(session: Session, options: MmLoginOptions = {}): Promise<Session> {
  const client = new MmClient(session.baseUrl, session.authToken, { fetch: options.fetch });
  const me = await client.get<Record<string, unknown>>('/users/me', { quiet: true });
  return { ...session, username: typeof me.username === 'string' ? me.username : session.username };
}

/** Best effort, like Rocket.Chat's: an already invalid token is a logout too. */
export async function logoutMattermost(session: Session, options: MmLoginOptions = {}): Promise<boolean> {
  if (session.kind === 'kchat') return true;
  const client = new MmClient(session.baseUrl, session.authToken, { fetch: options.fetch });
  try {
    await client.post('/users/logout', { quiet: true });
    return true;
  } catch (e) {
    return e instanceof MmError && e.rejectsToken;
  }
}

export type KchatServer = { id: string; name: string; displayName: string; url: string };

export async function kchatServers(token: string, options: MmLoginOptions = {}): Promise<KchatServer[]> {
  const client = new MmClient(KCHAT_DIRECTORY, token.trim(), { fetch: options.fetch });
  const list = await client.get<unknown>('/users/me/servers', { quiet: true });
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const s = raw as Record<string, unknown>;
    return typeof s.url === 'string' && typeof s.id === 'string' && isKchatServer(s.url)
      ? [{ id: s.id, name: String(s.name ?? ''), displayName: String(s.display_name ?? s.name ?? s.url), url: s.url.replace(/\/+$/, '') }]
      : [];
  });
}

/**
 * The server's version when it is a Mattermost, or null. `/system/ping` is
 * unauthenticated and answers `{status: "OK", ...}`; a Rocket.Chat or a proxy
 * answers 404 or HTML there, which reads as "not Mattermost".
 */
export async function probeMattermost(baseUrl: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/api/v4/system/ping`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = JSON.parse(await response.text()) as { status?: unknown };
    if (body.status !== 'OK') return null;
    return response.headers.get('x-version-id')?.split('.').slice(0, 3).join('.') ?? '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

const KCHAT_ORIGIN = /^https?:\/\/([a-z0-9-]+\.)*kchat\.infomaniak\.com(:443)?$/;

export function isKchatHost(baseUrl: string): boolean {
  const origin = originOf(baseUrl);
  return origin !== null && KCHAT_ORIGIN.test(origin);
}

/** The directory's answer decides where the account-wide Infomaniak token goes: https on Infomaniak only. */
function isKchatServer(url: string): boolean {
  return url.toLowerCase().startsWith('https://') && isKchatHost(url);
}

function sessionFrom(baseUrl: string, token: string, me: Record<string, unknown>, kind: ProviderKind): Session {
  if (typeof me.id !== 'string' || typeof me.username !== 'string') {
    throw new MmError(0, null, 'Account answer without an id.');
  }
  return { baseUrl, authToken: token, userId: me.id, username: me.username, kind, siteUrl: null };
}

/** Does an account that is not open have something unread? One read per list, token never revoked from here. */
export async function mattermostUnread(session: Session, options: MmLoginOptions = {}): Promise<boolean> {
  const client = new MmClient(session.baseUrl, session.authToken, { fetch: options.fetch });
  const [channels, members] = await Promise.all([
    client.get<Record<string, unknown>[]>('/users/me/channels', { quiet: true }),
    client.pages<Record<string, unknown>>('/users/me/channel_members', { quiet: true }),
  ]);
  const byId = new Map((Array.isArray(channels) ? channels : []).map((c) => [String(c.id), c]));
  return (Array.isArray(members) ? members : []).some((member) => {
    const channel = byId.get(String(member.channel_id));
    if (channel === undefined) return false;
    const { unread, mentions } = membershipCounts(channel, member);
    return unread > 0 || mentions > 0;
  });
}
