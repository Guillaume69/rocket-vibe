import { applySession, resumeSession as resumeRocketChatSession, logOut, type Session } from './auth.ts';
import { RestClient, isTokenRejected } from './rest.ts';
import { checkIdentity, resumeNative, transportFor } from '../providers/rocketvibe/auth.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';

export function clientForSession(session: Session, revoke: (token: string) => void): RestClient {
  // Legacy screens retain URL/account metadata, but cannot issue RC requests to a native server.
  const client = new RestClient(session.baseUrl, session.kind === 'rocketvibe' ? {
    fetch: async () => new Response(JSON.stringify({success:false,status:'error',error:'Unsupported native feature',errorType:'not-supported'}), {status:501,headers:{'content-type':'application/json'}}),
  } : undefined);
  client.onTokenRejected = revoke;
  client.kind = session.kind;
  applySession(client, session);
  return client;
}
export function sessionRejected(error: unknown): boolean {
  return isTokenRejected(error) || (error instanceof NativeError && error.status === 401 && error.code === 'session_rejected');
}
export function resumeSession(client: RestClient, session: Session): Promise<Session> {
  return session.kind === 'rocketvibe' ? resumeNative(client, session) : resumeRocketChatSession(client,session.authToken);
}
export async function logoutSession(client: RestClient, session: Session): Promise<boolean> {
  if (session.kind === 'rocketchat') return logOut(client);
  try {
    const transport = transportFor(session);
    checkIdentity(session, await transport.discover());
    await transport.logout();
    return true;
  } catch (error) {
    return sessionRejected(error);
  } finally { client.auth = null; }
}
