import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {finishNativeFactor,recoverNativeFactor,startNativeLogin,startNativeAccountCodeLogin,validLoginChallenge,type LoginChallenge} from './authentication.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const expires=()=>new Date(Date.now()+30*86_400_000).toISOString();
const discovery=()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,second_factors:true,device_sessions:true}});
const initial=():LoginChallenge=>({baseUrl:'https://example.org',instanceId:fixture.discovery.instance_id,dataEpoch:fixture.discovery.data_epoch,user:{...fixture.session.user},challenge:{challenge_id:'a'.repeat(64),methods:['totp','recovery_code'],expires_at:expires(),resend_after_seconds:0},pending:null});
const intent={operation_id:'b'.repeat(64),next_token:'c'.repeat(64)};
const current=()=>({id:'one-device',label:'Native',created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),expires_at:expires(),current:true});

test('lost factor ACK survives recreation and expiry without spending another code or clearing the pending vault',async()=>{
  let stored=initial();let random=0,writes=0,submits=0;let committed=false;
  const fetcher:typeof fetch=async(url,options)=>{
    const path=String(url);
    if(path.endsWith('/.well-known/rocketvibe'))return Response.json(discovery());
    if(path.endsWith('/auth/factors/verify')){
      submits++;assert(stored.pending);const body=JSON.parse(String(options?.body));
      assert.equal(body.next_token,stored.pending.next_token);assert.equal(body.operation_id,stored.pending.operation_id);
      assert.equal(new Headers(options?.headers).has('authorization'),false);
      committed=true;return Response.json({code:'lost_ack',request_id:'fixture'},{status:503});
    }
    assert.equal(new Headers(options?.headers).get('authorization'),`Bearer ${stored.pending?.next_token}`);
    if(path.endsWith('/me'))return committed?Response.json(fixture.session.user):Response.json({code:'session_rejected',request_id:'fixture'},{status:401});
    if(path.endsWith('/me/sessions'))return Response.json([current()]);
    throw new Error('Unexpected authentication request');
  };
  const deps={fetcher,token:async()=>String(++random+1).repeat(64),save:async(record:LoginChallenge)=>{writes++;stored=structuredClone(record);}};
  await assert.rejects(finishNativeFactor(stored,'totp','123456',deps),/lost_ack/);
  assert(stored.pending);assert(!JSON.stringify(stored).includes('123456'));
  stored.challenge.expires_at=new Date(Date.now()-86_400_000).toISOString();
  const resumed=await finishNativeFactor(stored,'totp','',deps);
  assert.equal(resumed.authToken,stored.pending.next_token);assert.equal(resumed.userId,stored.user.id);
  assert.equal(random,2);assert.equal(writes,1);assert.equal(submits,1);assert(stored.pending);
});

test('an uncommitted durable candidate resends exactly the original factor operation',async()=>{
  const stored={...initial(),pending:intent};let submits=0;
  const fetcher:typeof fetch=async(url,options)=>{
    if(String(url).endsWith('/.well-known/rocketvibe'))return Response.json(discovery());
    if(String(url).endsWith('/me'))return Response.json({code:'session_rejected',request_id:'fixture'},{status:401});
    submits++;assert.deepEqual(JSON.parse(String(options?.body)),{challenge_id:stored.challenge.challenge_id,method:'recovery_code',code:'BACKUP',...intent});
    return Response.json({...fixture.session,token:intent.next_token,expires_at:expires()});
  };
  const completed=await finishNativeFactor(stored,'recovery_code',' BACKUP ',{fetcher,token:async()=>{throw new Error('Unexpected randomness');},save:async()=>{throw new Error('Unexpected vault rewrite');}});
  assert.equal(completed.authToken,intent.next_token);assert.equal(submits,1);
});

test('secure storage failure and invalid CSPRNG output prevent factor mutations',async()=>{
  let submits=0,writes=0;
  const fetcher:typeof fetch=async(url)=>{
    if(!String(url).endsWith('/.well-known/rocketvibe'))submits++;
    return Response.json(discovery());
  };
  await assert.rejects(finishNativeFactor(initial(),'totp','123456',{fetcher,token:async()=>'b'.repeat(64),save:async()=>{writes++;throw new Error('Vault unavailable');}}),/Vault unavailable/);
  assert.equal(submits,0);assert.equal(writes,1);
  await assert.rejects(finishNativeFactor(initial(),'totp','123456',{fetcher,token:async()=>'invalid random',save:async()=>{writes++;}}),/invalid_native_authentication/);
  assert.equal(submits,0);assert.equal(writes,1);
});

test('malformed vault records are refused before discovery and generation changes preserve the pending candidate',async()=>{
  for(const saved of [{...initial(),extra:'field'},{...initial(),pending:{...intent,next_token:'short'}},{...initial(),pending:{...intent,next_token:'a'.repeat(64)}},{...initial(),challenge:{...initial().challenge,methods:['totp','totp']}}]){
    assert.equal(validLoginChallenge(saved),false);
    await assert.rejects(recoverNativeFactor(saved as LoginChallenge,async()=>{throw new Error('Unexpected HTTP');}),/invalid_native_authentication/);
  }
  const stored={...initial(),pending:intent};let submits=0;
  await assert.rejects(finishNativeFactor(stored,'totp','123456',{fetcher:async()=>{submits++;return Response.json({...discovery(),data_epoch:'restored'});},token:async()=>'',save:async()=>{throw new Error('Unexpected write');}}),/server_identity_changed/);
  assert.equal(submits,1);assert.deepEqual(stored.pending,intent);
});

test('ambiguous candidate probes never fall through to reuse a second factor',async()=>{
  for(const scenario of ['proxy','other-401','uid','duplicate-device','no-current','bad-expiry']){
    let submits=0;
    const fetcher:typeof fetch=async(url)=>{
      const path=String(url);
      if(path.endsWith('/.well-known/rocketvibe'))return Response.json(discovery());
      if(path.endsWith('/auth/factors/verify')){submits++;throw new Error('Unexpected factor mutation');}
      if(path.endsWith('/me')){
        if(scenario==='proxy')return Response.json({message:'Proxy authentication'},{status:401});
        if(scenario==='other-401')return Response.json({code:'other_error',request_id:'fixture'},{status:401});
        return Response.json({...fixture.session.user,id:scenario==='uid'?'another':fixture.session.user.id});
      }
      return Response.json(scenario==='duplicate-device'?[current(),current()]:scenario==='no-current'?[]:[{...current(),expires_at:'invalid'}]);
    };
    await assert.rejects(finishNativeFactor({...initial(),pending:intent},'totp','123456',{fetcher,token:async()=>'',save:async()=>{throw new Error('Unexpected write');}}));
    assert.equal(submits,0,scenario);
  }
});

test('bad factor responses cannot install a different UID, bearer, expiry or generation',async()=>{
  for(const scenario of ['uid','token','expiry','after']){
    let discoveries=0;
    const fetcher:typeof fetch=async(url)=>{
      if(String(url).endsWith('/.well-known/rocketvibe'))return Response.json({...discovery(),data_epoch:scenario==='after' && ++discoveries>1?'restored':fixture.discovery.data_epoch});
      if(String(url).endsWith('/me'))return Response.json({code:'session_rejected',request_id:'fixture'},{status:401});
      return Response.json({...fixture.session,token:scenario==='token'?'d'.repeat(64):intent.next_token,user:{...fixture.session.user,id:scenario==='uid'?'other':fixture.session.user.id},expires_at:scenario==='expiry'?'invalid':expires()});
    };
    const stored={...initial(),pending:intent};
    await assert.rejects(finishNativeFactor(stored,'totp','123456',{fetcher,token:async()=>'',save:async()=>{throw new Error('Unexpected write');}}));
    assert.deepEqual(stored.pending,intent);
  }
});

test('starting login pins discovery and preserves the legacy route on an older native server',async()=>{
  for(const nativeFactors of [false,true]){
    const requests:string[]=[];
    const fetcher:typeof fetch=async(url,options)=>{
      const path=String(url);requests.push(path);
      assert.equal(new Headers(options?.headers).has('authorization'),false);
      if(path.endsWith('/.well-known/rocketvibe'))return Response.json({...discovery(),capabilities:{...discovery().capabilities,second_factors:nativeFactors}});
      return Response.json(nativeFactors?{kind:'challenge',user:fixture.session.user,challenge:initial().challenge}:{...fixture.session,token:'e'.repeat(64),expires_at:expires()});
    };
    const step=await startNativeLogin('https://example.org',discovery(),{utilisateur:'alice',motDePasse:'transient-password'},fetcher);
    assert.equal(step.kind,nativeFactors?'challenge':'session');
    assert(requests[1].endsWith(nativeFactors?'/auth/start':'/auth/login'));
    assert(!JSON.stringify(step).includes('transient-password'));
  }
});

test('signup and password recovery follow full factor login and pin the account UID',async()=>{
  for(const recovery of [false,true])for(const scenario of ['ok','uid','capability']){
    let accepted=0;
    const fetcher:typeof fetch=async(url,options)=>{
      const path=String(url);assert.equal(new Headers(options?.headers).has('authorization'),false);
      if(path.endsWith('/.well-known/rocketvibe'))return Response.json({...discovery(),capabilities:{...discovery().capabilities,account_recovery:scenario!=='capability',account_invitations:scenario!=='capability'}});
      if(path.endsWith('/auth/start'))return Response.json({kind:'challenge',user:fixture.session.user,challenge:initial().challenge});
      accepted++;assert(path.endsWith(recovery?'/auth/recovery':'/auth/invitations/accept'));
      return Response.json({...fixture.session.user,id:scenario==='uid'?'another':fixture.session.user.id});
    };
    const result=startNativeAccountCodeLogin('https://example.org',discovery(),{utilisateur:'alice',motDePasse:'transient-password'},'operator-code',recovery,fetcher);
    if(scenario==='ok')assert.equal((await result).kind,'challenge');
    else await assert.rejects(result,scenario==='uid'?/server_identity_changed/:recovery?/recovery_unavailable/:/invitation_unavailable/);
    assert.equal(accepted,scenario==='capability'?0:1);
  }
});
