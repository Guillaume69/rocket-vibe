import type { Credentials, Session } from '../../lib/auth.ts';
import type { RestClient } from '../../lib/rest.ts';
import type { Discovery } from './protocol.generated.ts';
import { NativeError, NativeTransport } from './transport.ts';

export function assertNativeSession(session: Session): void {
  if (session.kind !== 'rocketvibe' || !session.nativeInstanceId || !session.nativeDataEpoch) throw new Error('Incomplete native session');
}
export function checkIdentity(session: Session, discovery: Discovery): void {
  assertNativeSession(session);
  if (discovery.instance_id !== session.nativeInstanceId || discovery.data_epoch !== session.nativeDataEpoch) throw new NativeError(409, 'server_identity_changed');
}
export function transportFor(session: Session, revoke?: (token: string) => void, fetcher?: typeof fetch): NativeTransport {
  assertNativeSession(session);
  const transport = new NativeTransport(session.baseUrl, fetcher);
  transport.restore(session.authToken);
  transport.onTokenRejected = revoke ?? null;
  return transport;
}
export async function nativeLogin(baseUrl: string, discovered: Discovery, credentials: Credentials, fetcher?: typeof fetch): Promise<Session> {
  const transport = new NativeTransport(baseUrl, fetcher);
  const fresh = await transport.discover();
  if (fresh.instance_id !== discovered.instance_id || fresh.data_epoch !== discovered.data_epoch) throw new NativeError(409, 'server_identity_changed');
  const result = await transport.login(credentials.user, credentials.password);
  const after = await transport.discover();
  if (after.instance_id !== fresh.instance_id || after.data_epoch !== fresh.data_epoch) throw new NativeError(409,'server_identity_changed');
  return {
    baseUrl: transport.baseUrl, userId: result.user.id, username: result.user.username,
    authToken: result.token, kind: 'rocketvibe', siteUrl: null,
    nativeInstanceId: fresh.instance_id, nativeDataEpoch: fresh.data_epoch,
    nativeExpiresAt: result.expires_at,
  };
}
export async function nativeRegister(baseUrl:string, discovered:Discovery, credentials:Credentials, token:string, fetcher?:typeof fetch):Promise<Session> {
  return accountCodeLogin(baseUrl,discovered,credentials,token,false,fetcher);
}
export async function nativeRecover(baseUrl:string, discovered:Discovery, credentials:Credentials, token:string, fetcher?:typeof fetch):Promise<Session> {
  return accountCodeLogin(baseUrl,discovered,credentials,token,true,fetcher);
}
async function accountCodeLogin(baseUrl:string, discovered:Discovery, credentials:Credentials, token:string, recovery:boolean, fetcher?:typeof fetch):Promise<Session> {
  const transport=new NativeTransport(baseUrl,fetcher);
  const fresh=await transport.discover();
  if (fresh.instance_id!==discovered.instance_id || fresh.data_epoch!==discovered.data_epoch) throw new NativeError(409,'server_identity_changed');
  if (!(recovery?fresh.capabilities.account_recovery:fresh.capabilities.account_invitations)) throw new NativeError(409,recovery?'recovery_unavailable':'invitation_unavailable');
  const user=recovery
    ? await transport.recoverAccount({token,username:credentials.user,new_password:credentials.password})
    : await transport.acceptInvitation({token,username:credentials.user,password:credentials.password});
  const after=await transport.discover();
  if (after.instance_id!==fresh.instance_id || after.data_epoch!==fresh.data_epoch) throw new NativeError(409,'server_identity_changed');
  const session=await nativeLogin(baseUrl,discovered,credentials,fetcher);
  if (session.userId!==user.id) throw new NativeError(409,'server_identity_changed');
  return session;
}
export async function resumeNative(client: RestClient, session: Session): Promise<Session> {
  const transport = transportFor(session, token => client.onTokenRejected?.(token));
  checkIdentity(session, await transport.discover());
  const me = await transport.me();
  if (me.id !== session.userId) throw new NativeError(401, 'session_rejected');
  return {...session, username: me.username};
}
