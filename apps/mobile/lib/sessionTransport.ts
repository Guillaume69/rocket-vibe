import { appliquerSession, reprendreSession, seDeconnecter, type Session } from './auth.ts';
import { ClientRest, estJetonRefuse } from './rest.ts';
import { checkIdentity, resumeNative, transportFor } from '../fournisseurs/rocketvibe/auth.ts';
import { NativeError } from '../fournisseurs/rocketvibe/transport.ts';

export function clientForSession(session: Session, revoke: (token: string) => void): ClientRest {
  // Legacy screens retain URL/account metadata, but cannot issue RC requests to a native server.
  const client = new ClientRest(session.baseUrl, session.genre === 'rocketvibe' ? {
    fetch: async () => new Response(JSON.stringify({success:false,status:'error',error:'Unsupported native feature',errorType:'not-supported'}), {status:501,headers:{'content-type':'application/json'}}),
  } : undefined);
  client.surJetonRefuse = revoke;
  appliquerSession(client, session);
  return client;
}
export function sessionRejected(error: unknown): boolean {
  return estJetonRefuse(error) || (error instanceof NativeError && error.status === 401 && error.code === 'session_rejected');
}
export function resumeSession(client: ClientRest, session: Session): Promise<Session> {
  return session.genre === 'rocketvibe' ? resumeNative(client, session) : reprendreSession(client,session.authToken);
}
export async function logoutSession(client: ClientRest, session: Session): Promise<boolean> {
  if (session.genre === 'rocketchat') return seDeconnecter(client);
  try {
    const transport = transportFor(session);
    checkIdentity(session, await transport.discover());
    await transport.logout();
    return true;
  } catch (error) {
    return sessionRejected(error);
  } finally { client.identifiants = null; }
}
