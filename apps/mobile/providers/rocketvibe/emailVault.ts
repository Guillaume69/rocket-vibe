/** One private intent slot for contact verification or removal on this family.
 * Codes are never stored; original bodies survive HTTP and storage failures. */
import type {BeginEmailVerification,ConfirmEmailVerification,EmailDeliveryState,EmailRemovalReceipt,EmailStatus,EmailVerificationStep,RemoveVerifiedEmail,ResumeEmailRemoval,ResumeEmailVerification,RetireEmailRemoval,RetireEmailVerification} from './protocol.generated.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';
import {checkSecurityScope,securityAlive,securityContext,securityKey,securityQueue,securityScope,type SecurityDependencies,type SecurityGuard,type SecurityScope} from './reauthenticationVault.ts';

export type EmailRemote={
  status:()=>Promise<EmailStatus>;
  begin:(input:BeginEmailVerification)=>Promise<EmailVerificationStep>;
  resume:(input:ResumeEmailVerification)=>Promise<EmailVerificationStep>;
  confirm:(input:ConfirmEmailVerification)=>Promise<EmailVerificationStep>;
  removed:(input:RetireEmailVerification)=>Promise<EmailStatus>;
  removal?:{
    begin:(input:RemoveVerifiedEmail)=>Promise<EmailRemovalReceipt>;
    resume:(input:ResumeEmailRemoval)=>Promise<EmailRemovalReceipt>;
    removed:(input:RetireEmailRemoval)=>Promise<EmailStatus>;
  };
};
type ContactStatus=EmailStatus & {address:string|null;verified_at:string|null};
export type EmailView={kind:'idle';status:ContactStatus}
  |{kind:'pending';status:ContactStatus;receipt:string;address:string;expires_at:string;delivery:EmailDeliveryState}
  |{kind:'verified'|'stale'|'removed'|'removal_pending'|'removal_stale';status:ContactStatus;receipt:string};
type Accepted={version:string;head:string};
type VerificationRecord={kind?:undefined;scope:SecurityScope;input:BeginEmailVerification;expires_at:string|null;accepted:Accepted|null};
type RemovalRecord={kind:'removal';scope:SecurityScope;input:RemoveVerifiedEmail;accepted:Accepted|null};
type Record=VerificationRecord|RemovalRecord;
type Saved={record:Record;raw:string};
function invalid():NativeError {return new NativeError(0,'invalid_native_security');}
function identifier(value:unknown):value is string {return typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);}
function exact(value:object,keys:string[]):void {if(Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key)))throw invalid();}
function address(value:string):string {
  const at=value.lastIndexOf('@');
  if(value.length>254 || at<1 || at===value.length-1 || /[^\x21-\x7e]/.test(value))throw new NativeError(400,'invalid_email_address');
  return value.slice(0,at+1)+value.slice(at+1).toLowerCase();
}
export function statusFor(scope:SecurityScope,value:EmailStatus):ContactStatus {
  const status=decodeNative('EmailStatus',value);
  checkSecurityScope(scope,status.context);
  const contact=status.address??null,verified=status.verified_at??null;
  if(!identifier(status.version) || !identifier(status.verification_version)
    || (contact===null)!==(verified===null)
    || (contact!==null && address(contact)!==contact)
    || (verified!==null && !Number.isFinite(Date.parse(verified))))throw invalid();
  return {address:contact,verified_at:verified,version:status.version,
    verification_version:status.verification_version,context:securityContext(scope)};
}
function recordFor(scope:SecurityScope,value:Record):Record {
  try {
    exact(value,value.kind==='removal'?['kind','scope','input','accepted']:['scope','input','expires_at','accepted']);
    const savedScope=securityScope(value.scope);checkSecurityScope(scope,savedScope);
    if(savedScope.baseUrl!==scope.baseUrl)throw invalid();
    if(value.kind==='removal'){
      const input=decodeNative('RemoveVerifiedEmail',value.input);checkSecurityScope(scope,input.context);
      if(!/^[a-f0-9]{64}$/.test(input.operation_id) || !identifier(input.expected_version) || !identifier(input.verification_version))throw invalid();
      acceptedFor(value.accepted,input);
      return {kind:'removal',scope:savedScope,input:{...input,context:securityContext(scope)},accepted:value.accepted && {...value.accepted}};
    }
    const input=decodeNative('BeginEmailVerification',value.input);checkSecurityScope(scope,input.context);
    if(!/^[a-f0-9]{64}$/.test(input.verification_id) || !/^[a-f0-9]{64}$/.test(input.operation_id)
      || !identifier(input.expected_version) || !identifier(input.verification_version) || address(input.address)!==input.address)throw invalid();
    if(value.expires_at!==null && (typeof value.expires_at!=='string' || value.expires_at.length>64 || !Number.isFinite(Date.parse(value.expires_at))))throw invalid();
    acceptedFor(value.accepted,input);
    return {scope:savedScope,input:{...input,context:securityContext(scope)},expires_at:value.expires_at,
      accepted:value.accepted && {...value.accepted}};
  } catch {throw invalid();}
}
function acceptedFor(value:Accepted|null,input:{expected_version:string;verification_version:string}):void {
  if(value!==null){
    exact(value,['version','head']);
    if(!identifier(value.version) || !identifier(value.head) || value.version===input.expected_version || value.head===input.verification_version)throw invalid();
  }
}
function removalMissing(error:unknown):boolean {
  return error instanceof NativeError && error.status===400 && error.code==='email_removal_rejected';
}
function removalRemote(remote:EmailRemote):NonNullable<EmailRemote['removal']> {
  if(!remote.removal)throw new NativeError(501,'unsupported_feature');return remote.removal;
}
function missing(error:unknown):boolean {
  return error instanceof NativeError && error.status===400 && error.code==='email_verification_rejected';
}
function invalidStart(error:unknown):boolean {
  return error instanceof NativeError && error.status===400 && ['invalid_request','invalid_email_address'].includes(error.code);
}
function verificationUnavailable(error:unknown):boolean {
  return error instanceof NativeError && ((error.status===501 && error.code==='unsupported_feature') || (error.status===503 && error.code==='email_unavailable'));
}

export class EmailVault {
  private readonly deps:SecurityDependencies;
  constructor(deps:SecurityDependencies){this.deps=deps;}
  private async read(key:string,scope:SecurityScope):Promise<Saved|null> {
    const raw=await this.deps.storage.read(`${key}-email`);if(raw===null)return null;
    try {if(raw.length>8192)throw invalid();return {raw,record:recordFor(scope,JSON.parse(raw))};}
    catch {throw invalid();}
  }
  private async save(key:string,scope:SecurityScope,expected:string|null,record:Record,guard:SecurityGuard):Promise<Saved> {
    record=recordFor(scope,record);securityAlive(guard);
    if(await this.deps.storage.read(`${key}-email`)!==expected)throw new NativeError(409,'credentials_changed');
    securityAlive(guard);const raw=JSON.stringify(record);
    await this.deps.storage.write(`${key}-email`,raw);securityAlive(guard);
    return {raw,record};
  }
  private async remove(key:string,saved:Saved,guard:SecurityGuard):Promise<void> {
    securityAlive(guard);
    if(await this.deps.storage.read(`${key}-email`)!==saved.raw)throw new NativeError(409,'credentials_changed');
    securityAlive(guard);await this.deps.storage.remove(`${key}-email`);securityAlive(guard);
  }
  private async live(scope:SecurityScope,remote:EmailRemote,guard:SecurityGuard):Promise<ContactStatus> {
    securityAlive(guard);const status=await remote.status();securityAlive(guard);return statusFor(scope,status);
  }
  private original(saved:Saved):ResumeEmailVerification {
    if(saved.record.kind==='removal')throw invalid();
    const {input}=saved.record;return {verification_id:input.verification_id,operation_id:input.operation_id,context:securityContext(saved.record.scope)};
  }
  private async result(key:string,saved:Saved,result:EmailVerificationStep,remote:EmailRemote,guard:SecurityGuard):Promise<EmailView> {
    if(saved.record.kind==='removal')throw invalid();
    result=decodeNative('EmailVerificationStep',result);const {record}=saved,input=record.input;
    const status=await this.live(record.scope,remote,guard);
    if(result.state==='verified'){
      if(result.address!==input.address || status.address!==result.address || status.version!==result.version
        || status.verified_at===null || status.verification_version===input.verification_version)throw new NativeError(409,'credentials_changed');
      await this.save(key,record.scope,saved.raw,{...record,accepted:{version:result.version,head:status.verification_version}},guard);
      return {kind:'verified',status,receipt:input.operation_id};
    }
    if(result.verification_id!==input.verification_id || result.operation_id!==input.operation_id
      || result.address!==input.address || result.expected_version!==input.expected_version
      || result.verification_version!==input.verification_version || !Number.isFinite(Date.parse(result.expires_at))
      || (record.expires_at!==null && record.expires_at!==result.expires_at))throw invalid();
    // The server owns expiry; a skewed device clock must not reject its reply.
    if(status.version!==input.expected_version || status.verification_version!==input.verification_version)return {kind:'stale',status,receipt:input.operation_id};
    if(record.expires_at===null)await this.save(key,record.scope,saved.raw,{...record,expires_at:result.expires_at},guard);
    return {kind:'pending',status,receipt:input.operation_id,address:input.address,expires_at:result.expires_at,delivery:result.delivery};
  }
  private async recover(key:string,scope:SecurityScope,remote:EmailRemote,guard:SecurityGuard):Promise<EmailView> {
    const status=await this.live(scope,remote,guard),saved=await this.read(key,scope);securityAlive(guard);
    if(!saved)return {kind:'idle',status};
    if(saved.record.kind==='removal')return this.recoverRemoval(key,saved,status,remote,guard);
    const {record}=saved,input=record.input;
    if(record.accepted)return {kind:status.version===record.accepted.version && status.verification_version===record.accepted.head && status.address===input.address?'verified':'stale',status,receipt:input.operation_id};
    let result:EmailVerificationStep;
    try {securityAlive(guard);result=await remote.resume(this.original(saved));securityAlive(guard);}
    catch(error){
      securityAlive(guard);if(!missing(error))throw error;
      // Only a start whose response was never recorded may retry its exact body.
      // The server's durable reservation forbids recreating a pruned challenge.
      if(record.expires_at!==null || status.version!==input.expected_version || status.verification_version!==input.verification_version)return {kind:'stale',status,receipt:input.operation_id};
      try {result=await remote.begin({...input,context:securityContext(scope)});securityAlive(guard);}
      catch(error){securityAlive(guard);if(missing(error) || invalidStart(error) || verificationUnavailable(error) || (error instanceof NativeError && error.status===409 && error.code==='operation_conflict'))return {kind:'stale',status,receipt:input.operation_id};throw error;}
    }
    return this.result(key,saved,result,remote,guard);
  }
  async resume(scope:SecurityScope,remote:EmailRemote,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,()=>this.recover(key,scope,remote,guard));
  }
  async start(scope:SecurityScope,remote:EmailRemote,value:string,expected:EmailStatus,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);expected=statusFor(scope,expected);value=address(value);
    const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      const existing=await this.read(key,scope);securityAlive(guard);
      if(existing)return this.recover(key,scope,remote,guard);
      const status=await this.live(scope,remote,guard);
      if(status.version!==expected.version || status.verification_version!==expected.verification_version)throw new NativeError(409,'credentials_changed');
      const candidate=await this.deps.token(),operation=await this.deps.token();securityAlive(guard);
      const input:BeginEmailVerification={address:value,verification_id:candidate,operation_id:operation,
        expected_version:status.version,verification_version:status.verification_version,context:securityContext(scope)};
      const saved=await this.save(key,scope,null,{scope,input,expires_at:null,accepted:null},guard);
      try {
        const result=await remote.begin({...input,context:securityContext(scope)});securityAlive(guard);
        return this.result(key,saved,result,remote,guard);
      } catch(error){
        securityAlive(guard);if(!invalidStart(error))throw error;
        return {kind:'stale',status:await this.live(scope,remote,guard),receipt:operation};
      }
    });
  }
  async confirm(scope:SecurityScope,remote:EmailRemote,receipt:string,code:string,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      const saved=await this.read(key,scope);securityAlive(guard);
      if(!saved || saved.record.kind==='removal' || saved.record.input.operation_id!==receipt)throw new NativeError(409,'credentials_changed');
      const view=await this.recover(key,scope,remote,guard);
      if(view.kind!=='pending')return view;
      if(!/^\d{8}$/.test(code))throw new NativeError(400,'email_verification_rejected');
      const latest=await this.read(key,scope);securityAlive(guard);
      if(!latest || latest.record.kind==='removal' || latest.record.input.operation_id!==receipt)throw new NativeError(409,'credentials_changed');
      const result=await remote.confirm({...this.original(latest),code});securityAlive(guard);
      if(result.state!=='verified')throw invalid();
      return this.result(key,latest,result,remote,guard);
    });
  }
  async cancel(scope:SecurityScope,remote:EmailRemote,receipt:string,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      await this.live(scope,remote,guard);const saved=await this.read(key,scope);securityAlive(guard);
      if(!saved || saved.record.input.operation_id!==receipt)throw new NativeError(409,'credentials_changed');
      if(saved.record.kind==='removal')return this.cancelRemoval(key,saved,remote,guard);
      const input=saved.record.input;
      const status=statusFor(scope,await remote.removed({context:securityContext(scope),expected_version:input.expected_version,verification_version:input.verification_version}));securityAlive(guard);
      if(status.verification_version===input.verification_version)throw invalid();
      try {
        const result=await remote.resume(this.original(saved));securityAlive(guard);
        if(result.state!=='verified')throw invalid();
        return this.result(key,saved,result,remote,guard);
      } catch(error){securityAlive(guard);if(!missing(error))throw error;}
      await this.remove(key,saved,guard);
      return {kind:'idle',status};
    });
  }
  private async removalResult(key:string,saved:Saved,value:EmailRemovalReceipt,remote:EmailRemote,guard:SecurityGuard):Promise<EmailView> {
    if(saved.record.kind!=='removal')throw invalid();
    const receipt=decodeNative('EmailRemovalReceipt',value),{record}=saved;
    checkSecurityScope(record.scope,receipt.context);
    acceptedFor({version:receipt.version,head:receipt.verification_version},record.input);
    const status=await this.live(record.scope,remote,guard);
    if(status.address!==null || status.version!==receipt.version || status.verification_version!==receipt.verification_version)throw new NativeError(409,'credentials_changed');
    await this.save(key,record.scope,saved.raw,{...record,accepted:{version:receipt.version,head:receipt.verification_version}},guard);
    return {kind:'removed',status,receipt:record.input.operation_id};
  }
  private async recoverRemoval(key:string,saved:Saved,status:ContactStatus,remote:EmailRemote,guard:SecurityGuard):Promise<EmailView> {
    if(saved.record.kind!=='removal')throw invalid();
    const {record}=saved,input=record.input;
    if(record.accepted)return {kind:status.address===null && status.version===record.accepted.version && status.verification_version===record.accepted.head?'removed':'removal_stale',status,receipt:input.operation_id};
    const endpoint=removalRemote(remote);let receipt:EmailRemovalReceipt;
    try {securityAlive(guard);receipt=await endpoint.resume({operation_id:input.operation_id,context:securityContext(record.scope)});securityAlive(guard);}
    catch(error){
      securityAlive(guard);if(!removalMissing(error))throw error;
      // A missing receipt is not evidence of success. Only the unchanged
      // original snapshot may retry; a pruned committed result stays stale.
      if(status.address===null || status.version!==input.expected_version || status.verification_version!==input.verification_version)return {kind:'removal_stale',status,receipt:input.operation_id};
      try {receipt=await endpoint.begin({...input,context:securityContext(record.scope)});securityAlive(guard);}
      catch(error){
        securityAlive(guard);
        if(error instanceof NativeError && error.status===403 && error.code==='reauthentication_required')return {kind:'removal_pending',status,receipt:input.operation_id};
        if(removalMissing(error) || invalidStart(error) || (error instanceof NativeError && error.status===409 && error.code==='operation_conflict'))return {kind:'removal_stale',status:await this.live(record.scope,remote,guard),receipt:input.operation_id};
        throw error;
      }
    }
    return this.removalResult(key,saved,receipt,remote,guard);
  }
  async removeContact(scope:SecurityScope,remote:EmailRemote,expected:EmailStatus,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);expected=statusFor(scope,expected);const endpoint=removalRemote(remote);
    const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      // One private slot holds either intent. An old verification must be
      // closed explicitly before consent to remove its resulting contact.
      if(await this.read(key,scope)!==null)throw new NativeError(409,'credentials_changed');securityAlive(guard);
      const status=await this.live(scope,remote,guard);
      if(status.address===null || status.address!==expected.address || status.version!==expected.version || status.verification_version!==expected.verification_version)throw new NativeError(409,'credentials_changed');
      const operation=await this.deps.token();securityAlive(guard);
      const input:RemoveVerifiedEmail={operation_id:operation,expected_version:status.version,verification_version:status.verification_version,context:securityContext(scope)};
      const saved=await this.save(key,scope,null,{kind:'removal',scope,input,accepted:null},guard);
      let receipt:EmailRemovalReceipt;
      try {securityAlive(guard);receipt=await endpoint.begin({...input,context:securityContext(scope)});securityAlive(guard);}
      catch(error){
        securityAlive(guard);
        if(error instanceof NativeError && (error.status===0 || error.status>=500 || (error.status===403 && error.code==='reauthentication_required')))return {kind:'removal_pending',status:await this.live(scope,remote,guard),receipt:operation};
        if(removalMissing(error) || invalidStart(error) || (error instanceof NativeError && error.status===409 && error.code==='operation_conflict'))return {kind:'removal_stale',status:await this.live(scope,remote,guard),receipt:operation};
        throw error;
      }
      return this.removalResult(key,saved,receipt,remote,guard);
    });
  }
  private async cancelRemoval(key:string,saved:Saved,remote:EmailRemote,guard:SecurityGuard):Promise<EmailView> {
    if(saved.record.kind!=='removal')throw invalid();
    const {record}=saved,input=record.input;
    if(record.accepted){
      const status=await this.live(record.scope,remote,guard),view=await this.recoverRemoval(key,saved,status,remote,guard);
      if(view.kind==='removed')return view;
      await this.remove(key,saved,guard);return {kind:'idle',status};
    }
    const endpoint=removalRemote(remote);
    securityAlive(guard);
    const status=statusFor(record.scope,await endpoint.removed({expected_version:input.expected_version,verification_version:input.verification_version,context:securityContext(record.scope)}));securityAlive(guard);
    if(status.version===input.expected_version && status.verification_version===input.verification_version)throw invalid();
    // Never resend the removal while trying to cancel it. A committed receipt
    // wins, including when the first successful response was lost.
    try {
      const receipt=await endpoint.resume({operation_id:input.operation_id,context:securityContext(record.scope)});securityAlive(guard);
      return this.removalResult(key,saved,receipt,remote,guard);
    }catch(error){securityAlive(guard);if(!removalMissing(error))throw error;}
    await this.remove(key,saved,guard);return {kind:'idle',status};
  }
  async acknowledge(scope:SecurityScope,remote:EmailRemote,receipt:string,guard:SecurityGuard=()=>true):Promise<EmailView> {
    scope=securityScope(scope);const key=await securityKey(scope,this.deps.hash);
    return securityQueue(key,async()=>{
      const status=await this.live(scope,remote,guard),saved=await this.read(key,scope);securityAlive(guard);
      if(!saved || saved.record.input.operation_id!==receipt || !saved.record.accepted)throw new NativeError(409,'credentials_changed');
      await this.remove(key,saved,guard);return {kind:'idle',status};
    });
  }
}
