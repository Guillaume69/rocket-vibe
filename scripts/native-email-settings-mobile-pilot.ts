/** Disposable provider/SQLite/HTTP bench. Portable private files stand in for
 * SecureStore and are removed with the fixture volume. Never print a secret. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {NativeTransport,NativeError} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {FactorVault} from '../apps/mobile/fournisseurs/rocketvibe/factorVault.ts';
import {ReauthenticationVault} from '../apps/mobile/fournisseurs/rocketvibe/reauthenticationVault.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import type {Session} from '../apps/mobile/lib/auth.ts';
const directory='/pilot-invitations/mobile-email-settings',base='http://factor-proxy:3401',token=()=>randomBytes(32).toString('hex');
let step='initialization';
async function main(){
  const phase=process.env.RV_EMAIL_SETTINGS_PHASE;
  assert(['enable','resume-disable','resume-disabled'].includes(phase!));
  await mkdir(directory,{recursive:true,mode:0o700});
  const transport=new NativeTransport(base);
  let session:Session;
  if(phase==='enable'){
    const discovery=await transport.discover(),login=await transport.login('gtk-email','native-pilot-test-password');
    session={baseUrl:base,authToken:login.token,userId:login.user.id,username:login.user.username,siteUrl:null,genre:'rocketvibe',nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
    await writeFile(`${directory}/session`,JSON.stringify(session),{mode:0o600});
  } else {session=JSON.parse(await readFile(`${directory}/session`,'utf8'));transport.restore(session.authToken);}
  const {db,adapter}=nativeTestDatabase(`${directory}/projection.sqlite`,phase==='enable');
  const store=new NativeStore(adapter,creerFileEcritures(),session),chat=new NativeChat(session,store,token,{transport});
  const deps={hash:async(value:string)=>createHash('sha256').update(value).digest('hex'),token:async()=>token(),storage:{
    read:async(key:string)=>{try{return await readFile(`${directory}/${key}`,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},
    write:async(key:string,value:string)=>{await writeFile(`${directory}/${key}`,value,{mode:0o600});},
    remove:async(key:string)=>{try{await unlink(`${directory}/${key}`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  }};
  const vault=()=>new FactorVault(deps);
  try{
    step='provider connection';await chat.connect();assert(chat.status.online);
    let access=await chat.security();
    if(phase==='enable'){
      const contact=await access.email.status(),factors=await access.remote.status();
      step='lost activation ACK';await assert.rejects(vault().startEmail(access.scope,access.remote,{contact,factors,enabled:true},access.alive));
    } else if(phase==='resume-disable'){
      step='original activation receipt';const receipt=await vault().resume(access.scope,access.remote,access.alive);assert(receipt.kind==='codes');
      assert(receipt.codes.codes.length===10);
      const repeated=await vault().resume(access.scope,access.remote,access.alive);assert(repeated.kind==='codes' && JSON.stringify(repeated.codes)===JSON.stringify(receipt.codes));
      step='new profile requires full identity proof';
      const proof=()=>new ReauthenticationVault(deps);
      await assert.rejects(proof().prepare(access.scope,access.remote.proof,'native-pilot-test-password',access.alive));
      const challenge=await proof().prepare(access.scope,access.remote.proof,'',access.alive);assert(challenge.kind==='challenge');
      await assert.rejects(proof().finish(challenge.attempt,access.remote.proof,'recovery_code',receipt.codes.codes[0],access.alive));
      assert((await proof().prepare(access.scope,access.remote.proof,'',access.alive)).kind==='ready');
      assert(await vault().clear(access.scope,receipt.receipt,access.alive));
      access=await chat.security();const contact=await access.email.status(),factors=await access.remote.status();assert(factors.email && !factors.totp);
      step='lost removal ACK';await assert.rejects(vault().startEmail(access.scope,access.remote,{contact,factors,enabled:false},access.alive));
    } else {
      step='original removal receipt';assert((await vault().resume(access.scope,access.remote,access.alive)).kind==='idle');
      const contact=await access.email.status(),factors=await access.remote.status();assert(contact.address==='gtk-email@example.test' && !factors.email && !factors.totp && factors.backup_codes_remaining===0);
      step='closed provider';chat.stop();await assert.rejects(access.remote.emailSettings!.status(),e=>e instanceof NativeError && e.code==='session_closed');
    }
    console.log(`Mobile email settings phase ${phase}: verified`);
  } finally {chat.stop();await store.state();db.close();}
}
main().catch(()=>{console.error(`Mobile email settings failed during ${step}`);process.exitCode=1;});
