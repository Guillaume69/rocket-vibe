/** Registration is account-scoped; the native receiver only trusts the saved
 * instance / epoch / device family, never a URL carried by FCM. */
import type {Session} from '../../lib/auth.ts';
import {checkIdentity,transportFor} from './auth.ts';
import {NativeError,type NativeTransport} from './transport.ts';

export async function registerNativePush(session:Session,token:string,save:(session:Session,device:string)=>Promise<void>,remote:NativeTransport=transportFor(session)):Promise<void> {
  const discovery=await remote.discover();checkIdentity(session,discovery);
  if(!discovery.capabilities.push)throw new NativeError(501,'unsupported_feature');
  const receipt=await remote.registerPush(token);
  if(receipt.instance_id!==session.nativeInstanceId || receipt.data_epoch!==session.nativeDataEpoch || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.device_id))throw new NativeError(409,'server_identity_changed');
  checkIdentity(session,await remote.discover());
  await save(session,receipt.device_id);
}
