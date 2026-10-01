/** Platform adapters serialize this record in the account's secure store. */
import type { Session } from '../../lib/auth.ts';
import { checkIdentity, transportFor } from './auth.ts';
import type { RenewSession } from './protocol.generated.ts';
import type { User } from './protocol.generated.ts';
import { NativeError, type NativeTransport } from './transport.ts';

export type CredentialRecord={session:Session;pending:RenewSession|null;expires_at:string|null};
export type RenewalDependencies={
  /** CSPRNG, never Math.random; generate 32 bytes encoded as lowercase hex. */
  token:()=>Promise<string>;
  /** Fail when another login replaced the expected account/token. */
  save:(record:CredentialRecord)=>Promise<void>;
  transport?:(session:Session)=>NativeTransport;
};
export function renewalDue(record:CredentialRecord,now=Date.now()):boolean {
  return record.pending!==null || (record.expires_at!==null && Date.parse(record.expires_at)<=now+2*86_400_000);
}
export async function renewCredentials(record:CredentialRecord,deps:RenewalDependencies):Promise<CredentialRecord> {
  record={...record,session:{...record.session},pending:record.pending && {...record.pending}};
  const transport=(deps.transport??transportFor)(record.session);
  transport.surJetonRefuse=null;
  const discovered=await transport.discover();checkIdentity(record.session,discovered);
  if (!discovered.capabilities.session_rotation) throw new NativeError(501,'unsupported_feature');
  if (record.pending) {
    // No rejection callback here: a not-yet-committed successor is expected to
    // return 401. It must never sign out the still-valid previous session.
    transport.restore(record.pending.next_token);
    let user:User|null=null;
    try {
      user=await transport.me();
    } catch (error) {
      if (!(error instanceof NativeError && error.status===401 && error.code==='session_rejected')) throw error;
    }
    if (user) {
      if (user.id!==record.session.userId) throw new NativeError(401,'session_rejected');
      const current=(await transport.deviceSessions()).find(d=>d.current);
      if (!current) throw new NativeError(401,'session_rejected');
      checkIdentity(record.session,await transport.discover());
      record.session={...record.session,authToken:record.pending.next_token,username:user.username};
      record.expires_at=current.expires_at;record.pending=null;
      await deps.save(record);return record;
    }
  } else {
    const operation_id=await deps.token(),next_token=await deps.token();
    if (!/^[a-f0-9]{64}$/.test(operation_id) || !/^[a-f0-9]{64}$/.test(next_token) || next_token===record.session.authToken) throw new Error('Invalid secure random output');
    record.pending={operation_id,next_token};await deps.save(record);
  }
  transport.restore(record.session.authToken);
  const renewed=await transport.renew(record.pending!);
  if (renewed.token!==record.pending!.next_token || renewed.user.id!==record.session.userId || !Number.isFinite(Date.parse(renewed.expires_at))) throw new NativeError(502,'invalid_native_session');
  checkIdentity(record.session,await transport.discover());
  record.session={...record.session,authToken:renewed.token,username:renewed.user.username};
  record.expires_at=renewed.expires_at;record.pending=null;
  await deps.save(record);return record;
}
