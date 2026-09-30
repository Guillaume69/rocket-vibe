/** Native discovery first; a positively identified native server never falls back to RC. */
import { normaliserUrl, sonderServeur, type ProfilServeur } from './server.ts';
import { NativeTransport } from '../fournisseurs/rocketvibe/transport.ts';
import type { Discovery } from '../fournisseurs/rocketvibe/protocol.generated.ts';
export type ServerProfile = ProfilServeur & { native?: Discovery };

export async function discoverServer(input: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ServerProfile> {
  const baseUrl = normaliserUrl(input);
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
    } else if (response.status !== 404 && response.status !== 410) {
      throw new Error('Découverte du serveur indisponible.');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
  if (!native) return sonderServeur(baseUrl, signal, {fetch:fetcher});
  const discovery = await new NativeTransport(baseUrl,fetcher).discover(signal);
  return {
    baseUrl, version:discovery.server_version, siteUrl:null, formulaireDeConnexion:true,
    deuxFacteurs:{actif:false,totp:false,email:false},ldap:false,oauth:[],
    e2eeActif:discovery.capabilities.e2ee, fichiersProteges:true,avatarsProteges:true,
    native:discovery,
  };
}
