/** In-process PostgreSQL/HTTP/SMTP fixture only; no production mail or account. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {NativeError,NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {EmailVault} from '../apps/mobile/fournisseurs/rocketvibe/emailVault.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import type {Session} from '../apps/mobile/lib/auth.ts';

let phase='initialization';
async function main(){
  const base=process.argv[2];if(!base || !process.env.RV_EMAIL_PILOT_PASSWORD)throw new Error();
  let lostStart=false,lostConfirm=false;
  const transport=new NativeTransport(base,async(url,options)=>{
    const response=await fetch(url,options);
    if(response.ok && String(url).endsWith('/email/verification/start') && !lostStart){lostStart=true;await response.arrayBuffer();throw new NativeError(0,'network_or_protocol_error');}
    if(response.ok && String(url).endsWith('/email/verification/confirm') && !lostConfirm){lostConfirm=true;await response.arrayBuffer();throw new NativeError(0,'network_or_protocol_error');}
    return response;
  });
  const discovery=await transport.discover(),login=await transport.login('owner',process.env.RV_EMAIL_PILOT_PASSWORD);
  assert.equal(discovery.capabilities.email_verification,true);
  const session:Session={baseUrl:base,authToken:login.token,userId:login.user.id,username:login.user.username,
    siteUrl:null,genre:'rocketvibe',nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const {db,adapter}=nativeTestDatabase(),store=new NativeStore(adapter,creerFileEcritures(),session);
  const chat=new NativeChat(session,store,()=>randomBytes(32).toString('hex'),{transport});
  const values=new Map<string,string>();let failReceipt=false;
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>randomBytes(32).toString('hex'),
    storage:{read:async(key:string)=>values.get(key)??null,
      write:async(key:string,value:string)=>{if(failReceipt && JSON.parse(value).accepted!==null){failReceipt=false;throw new Error('private-store-unavailable');}values.set(key,value);},
      remove:async(key:string)=>{values.delete(key);}},
  };
  const vault=()=>new EmailVault(deps);
  try {
    phase='connected provider';await chat.connect();assert.equal(chat.status.online,true);
    const access=await chat.security(),initial=await vault().resume(access.scope,access.email,access.alive);
    assert.equal(initial.kind,'idle');
    phase='lost start reply';
    await assert.rejects(vault().start(access.scope,access.email,'owner@example.test',initial.status,access.alive),/network_or_protocol_error/);
    const pending=await vault().resume(access.scope,access.email,access.alive);if(pending.kind!=='pending')throw new Error();
    const originalDeadline=pending.expires_at;
    phase='actual SMTP delivery';
    const delivery=await fetch(`${base}/__email_fixture/deliver`,{headers:{authorization:`Bearer ${login.token}`}});
    assert.equal(delivery.ok,true);
    const delivered=await delivery.json() as {delivered:number;code:string};assert.equal(delivered.delivered,1);
    const received=await vault().resume(access.scope,access.email,access.alive);if(received.kind!=='pending')throw new Error();
    assert.equal(received.delivery,'accepted');assert.equal(received.expires_at,originalDeadline);
    phase='lost confirmation reply';
    await assert.rejects(vault().confirm(access.scope,access.email,received.receipt,delivered.code,access.alive),/network_or_protocol_error/);
    assert.equal([...values.values()].every(raw=>!raw.includes(delivered.code)),true);
    phase='private receipt write failure';failReceipt=true;
    await assert.rejects(vault().resume(access.scope,access.email,access.alive),/private-store-unavailable/);
    phase='receipt recovery';const verified=await vault().resume(access.scope,access.email,access.alive);
    assert.equal(verified.kind,'verified');if(verified.kind!=='verified')throw new Error();
    assert.equal(verified.status.address,'owner@example.test');
    await vault().acknowledge(access.scope,access.email,verified.receipt,access.alive);assert.equal(values.size,0);
    phase='closed provider';chat.stop();await assert.rejects(access.email.status(),/session_closed/);
    process.stdout.write('native email mobile pilot: verified\n');
  } finally {chat.stop();await store.state();db.close();}
}
void main().catch(()=>{process.stderr.write(`Native email mobile pilot failed during ${phase}\n`);process.exitCode=1;});
