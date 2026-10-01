import type { Credentials, Session } from '../../lib/auth.ts';
import type { ClientRest } from '../../lib/rest.ts';
import type { Discovery } from './protocol.generated.ts';
import { NativeError, NativeTransport } from './transport.ts';

export function assertNativeSession(session: Session): void {
  if (session.genre !== 'rocketvibe' || !session.nativeInstanceId || !session.nativeDataEpoch) throw new Error('Incomplete native session');
}
export function checkIdentity(session: Session, discovery: Discovery): void {
  assertNativeSession(session);
  if (discovery.instance_id !== session.nativeInstanceId || discovery.data_epoch !== session.nativeDataEpoch) throw new NativeError(409, 'server_identity_changed');
}
export function transportFor(session: Session, revoke?: (token: string) => void, fetcher?: typeof fetch): NativeTransport {
  assertNativeSession(session);
  const transport = new NativeTransport(session.baseUrl, fetcher);
  transport.restore(session.authToken);
  transport.surJetonRefuse = revoke ?? null;
  return transport;
}
export async function nativeLogin(baseUrl: string, discovered: Discovery, credentials: Credentials): Promise<Session> {
  const transport = new NativeTransport(baseUrl);
  const fresh = await transport.discover();
  if (fresh.instance_id !== discovered.instance_id || fresh.data_epoch !== discovered.data_epoch) throw new NativeError(409, 'server_identity_changed');
  const result = await transport.login(credentials.utilisateur, credentials.motDePasse);
  return {
    baseUrl: transport.baseUrl, userId: result.user.id, username: result.user.username,
    authToken: result.token, genre: 'rocketvibe', siteUrl: null,
    nativeInstanceId: fresh.instance_id, nativeDataEpoch: fresh.data_epoch,
    nativeExpiresAt: result.expires_at,
  };
}
export async function resumeNative(client: ClientRest, session: Session): Promise<Session> {
  const transport = transportFor(session, token => client.surJetonRefuse?.(token));
  checkIdentity(session, await transport.discover());
  const me = await transport.me();
  if (me.id !== session.userId) throw new NativeError(401, 'session_rejected');
  return {...session, username: me.username};
}
