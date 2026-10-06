/** Durable delivery metadata belongs to the original private challenge slot.
 * Reading/restoring a form never starts a mail. Only an explicit user action
 * can start/retry the same candidate or request a new, bounded resend. */
import type {AuthChallenge,FactorEmailDelivery,RequestFactorEmail} from './protocol.generated.ts';
import {NativeError} from './transport.ts';
import {decodeNative} from './validation.ts';

export type EmailDeliveryIntent={input:RequestFactorEmail;status:FactorEmailDelivery|null};
export type EmailDeliveryRemote={
  begin:(input:RequestFactorEmail)=>Promise<FactorEmailDelivery>;
  resume:(input:RequestFactorEmail)=>Promise<FactorEmailDelivery>;
};
type Dependencies={
  token:()=>Promise<string>;
  save:(intent:EmailDeliveryIntent)=>Promise<void>;
  remote:EmailDeliveryRemote;
  alive:()=>boolean;
};
const token=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function invalid():NativeError {return new NativeError(0,'invalid_native_security');}
function exact(value:unknown,keys:string[]):void {
  if(!value || typeof value!=='object' || Object.keys(value).length!==keys.length
    || Object.keys(value).some(key=>!keys.includes(key)))throw invalid();
}
function statusFor(challenge:AuthChallenge,value:unknown):FactorEmailDelivery {
  exact(value,['delivery','expires_at','resend_after_seconds']);
  const status=decodeNative('FactorEmailDelivery',value);
  if(!Number.isFinite(Date.parse(status.expires_at))
    || Date.parse(status.expires_at)!==Date.parse(challenge.expires_at)
    || !Number.isInteger(status.resend_after_seconds) || status.resend_after_seconds<0 || status.resend_after_seconds>60)throw invalid();
  return {delivery:status.delivery,expires_at:status.expires_at,resend_after_seconds:status.resend_after_seconds};
}
export function emailDeliveryIntent(value:unknown,challenge:AuthChallenge):EmailDeliveryIntent {
  try {
    exact(value,['input','status']);
    const record=value as EmailDeliveryIntent;
    const input=decodeNative('RequestFactorEmail',record.input);
    if(!challenge.methods.includes('email') || input.challenge_id!==challenge.challenge_id
      || !token(input.delivery_id) || !token(input.operation_id)
      || input.delivery_id===input.challenge_id || input.delivery_id===input.operation_id
      || input.operation_id===input.challenge_id)throw invalid();
    return {input:{...input},status:record.status===null?null:statusFor(challenge,record.status)};
  } catch {throw invalid();}
}
function alive(deps:Dependencies):void {if(!deps.alive())throw new NativeError(0,'session_closed');}
function missing(error:unknown):boolean {return error instanceof NativeError && error.status===400 && error.code==='factor_rejected';}

/** Called only for an explicit send/retry/resend gesture, under the parent vault
 * lease. A new candidate is impossible while a previous result is ambiguous. */
export async function sendFactorEmail(
  challenge:AuthChallenge,previous:EmailDeliveryIntent|null,resend:boolean,deps:Dependencies,
):Promise<EmailDeliveryIntent> {
  alive(deps);
  if(!challenge.methods.includes('email'))throw new NativeError(501,'unsupported_feature');
  let intent=previous===null?null:emailDeliveryIntent(previous,challenge);
  if(resend && !intent?.status)throw new NativeError(409,'credentials_changed');
  if(intent){
    try {
      const status=statusFor(challenge,await deps.remote.resume({...intent.input}));alive(deps);
      intent={input:intent.input,status};
      await deps.save(emailDeliveryIntent(intent,challenge));alive(deps);
      if(!resend)return emailDeliveryIntent(intent,challenge);
      if(status.resend_after_seconds>0)throw new NativeError(429,'email_resend_cooldown',status.resend_after_seconds);
    } catch(error){
      alive(deps);
      if(!missing(error) || resend)throw error;
      // The initial command may have been interrupted before SQL insertion.
      // Its explicit retry repeats the exact saved candidate, never a new one.
    }
  }
  if(!intent || resend){
    const delivery=await deps.token(),operation=await deps.token();alive(deps);
    intent=emailDeliveryIntent({input:{challenge_id:challenge.challenge_id,delivery_id:delivery,operation_id:operation},status:null},challenge);
    await deps.save(emailDeliveryIntent(intent,challenge));alive(deps);
  }
  const status=statusFor(challenge,await deps.remote.begin({...intent.input}));alive(deps);
  const result=emailDeliveryIntent({input:intent.input,status},challenge);
  await deps.save(emailDeliveryIntent(result,challenge));alive(deps);
  return emailDeliveryIntent(result,challenge);
}
