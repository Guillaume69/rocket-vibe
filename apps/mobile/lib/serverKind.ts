/** Native discovery first; a positively identified native server never falls back to RC. */
import { normalizeUrl, probeServer, type ServerProfile as BaseServerProfile } from './server.ts';
import { NativeTransport } from '../providers/rocketvibe/transport.ts';
import type { Discovery } from '../providers/rocketvibe/protocol.generated.ts';
import { isKchatHost, probeMattermost } from '../providers/mattermost/auth.ts';
/** `mattermost`: a Mattermost or kChat server, signed in through its own flow. */
export type ServerProfile = BaseServerProfile & { native?: Discovery; mattermost?: { kind: 'mattermost' | 'kchat' } };
/** Found by probing (`auto`), or forced when the probe gets it wrong behind an unusual proxy. */
export type ServerKind = 'auto' | 'rocketchat' | 'rocketvibe' | 'mattermost' | 'kchat';
/** The server is not RocketVibe although the user chose it. */
export class NotRocketVibeError extends Error {}
/** The server is not Mattermost although the user chose it. */
export class NotMattermostError extends Error {}

function mattermostProfile(baseUrl: string, version: string, kind: 'mattermost' | 'kchat'): ServerProfile {
  return {
    baseUrl, version, siteUrl:null, loginForm:kind === 'mattermost',
    twoFactor:{active:false,totp:false,email:false},ldap:false,oauth:[],
    e2eeEnabled:false, filesProtected:true, avatarsProtected:true,
    mattermost:{kind},
  };
}

export async function discoverServer(input: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, kind: ServerKind = 'auto'): Promise<ServerProfile> {
  const baseUrl = normalizeUrl(input);
  // Rocket.Chat chosen: no native discovery at all.
  if (kind === 'rocketchat') return probeServer(baseUrl, signal, {fetch:fetcher});
  // kChat: the team servers are found after sign-in, from the Infomaniak account.
  if (kind === 'kchat' || (kind === 'auto' && isKchatHost(baseUrl))) return mattermostProfile(baseUrl, '', 'kchat');
  if (kind === 'mattermost') {
    const version = await probeMattermost(baseUrl, signal, fetcher);
    if (version === null) throw new NotMattermostError('Not a Mattermost server');
    return mattermostProfile(baseUrl, version, 'mattermost');
  }
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let native = false;
  try {
    const response = await fetcher(`${baseUrl}/.well-known/rocketvibe`, {signal:controller.signal,redirect:'error'});
    if (response.ok) {
      const body: unknown = await response.text();
      try {
        const parsed: unknown = JSON.parse(String(body));
        native = typeof parsed === 'object' && parsed !== null && 'product' in parsed && parsed.product === 'rocketvibe';
      } catch { /* An RC frontend may serve HTML for unknown routes. */ }
    }
    // Only a 2xx naming the product identifies a RocketVibe server. Anything
    // else falls back to the Rocket.Chat probe, which has its own proofs: a
    // reverse proxy may well forbid `/.well-known/` (chat.barrut.me answers
    // 403), and a refusal used to hide the Rocket.Chat behind it.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
  if (!native && kind === 'rocketvibe') throw new NotRocketVibeError('Not a RocketVibe server');
  if (!native) {
    const version = await probeMattermost(baseUrl, signal, fetcher);
    if (version !== null) return mattermostProfile(baseUrl, version, 'mattermost');
    return probeServer(baseUrl, signal, {fetch:fetcher});
  }
  const discovery = await new NativeTransport(baseUrl,fetcher).discover(signal);
  return {
    baseUrl, version:discovery.server_version, siteUrl:null, loginForm:true,
    twoFactor:{active:false,totp:false,email:false},ldap:false,oauth:[],
    e2eeEnabled:discovery.capabilities.e2ee, filesProtected:true,avatarsProtected:true,
    native:discovery,
  };
}
