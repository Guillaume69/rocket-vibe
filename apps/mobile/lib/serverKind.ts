/** Native discovery first; a positively identified native server never falls back to RC. */
import { normalizeUrl, probeServer, type ServerProfile as BaseServerProfile } from './server.ts';
import { NativeTransport } from '../providers/rocketvibe/transport.ts';
import type { Discovery } from '../providers/rocketvibe/protocol.generated.ts';
export type ServerProfile = BaseServerProfile & { native?: Discovery };

export async function discoverServer(input: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ServerProfile> {
  const baseUrl = normalizeUrl(input);
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
  if (!native) return probeServer(baseUrl, signal, {fetch:fetcher});
  const discovery = await new NativeTransport(baseUrl,fetcher).discover(signal);
  return {
    baseUrl, version:discovery.server_version, siteUrl:null, loginForm:true,
    twoFactor:{active:false,totp:false,email:false},ldap:false,oauth:[],
    e2eeEnabled:discovery.capabilities.e2ee, filesProtected:true,avatarsProtected:true,
    native:discovery,
  };
}
