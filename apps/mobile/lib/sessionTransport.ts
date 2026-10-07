import { applySession, resumeSession as resumeRocketChatSession, logOut, type Session } from './auth.ts';
import { RestClient, isTokenRejected } from './rest.ts';
import { checkIdentity, resumeNative, transportFor } from '../providers/rocketvibe/auth.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { MmError } from '../providers/mattermost/client.ts';
import { logoutMattermost, resumeMattermost } from '../providers/mattermost/auth.ts';

export function clientForSession(session: Session, revoke: (token: string) => void): RestClient {
  // Legacy screens retain URL/account metadata, but cannot issue RC requests to another server.
  const client = new RestClient(session.baseUrl, session.kind !== 'rocketchat' ? {
    fetch: async () => new Response(JSON.stringify({success:false,status:'error',error:'Unsupported native feature',errorType:'not-supported'}), {status:501,headers:{'content-type':'application/json'}}),
  } : undefined);
  client.onTokenRejected = revoke;
  client.kind = session.kind;
  applySession(client, session);
  return client;
}
export function sessionRejected(error: unknown): boolean {
  return isTokenRejected(error)
    || (error instanceof NativeError && error.status === 401 && error.code === 'session_rejected')
    || (error instanceof MmError && error.status === 401);
}
export function resumeSession(client: RestClient, session: Session): Promise<Session> {
  switch (session.kind) {
    case 'rocketvibe': return resumeNative(client, session);
    case 'mattermost':
    case 'kchat': return resumeMattermost(session);
    case 'rocketchat': return resumeRocketChatSession(client,session.authToken);
  }
}
export async function logoutSession(client: RestClient, session: Session): Promise<boolean> {
  if (session.kind === 'rocketchat') return logOut(client);
  if (session.kind === 'mattermost' || session.kind === 'kchat') {
    try { return await logoutMattermost(session); } finally { client.auth = null; }
  }
  try {
    const transport = transportFor(session);
    checkIdentity(session, await transport.discover());
    await transport.logout();
    return true;
  } catch (error) {
    return sessionRejected(error);
  } finally { client.auth = null; }
}
