import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SessionCollector,BridgeError,slackUrl,candidates,sessionCookie,sealSession } from './session.mjs';
import { snapshotExpression } from './browser.mjs';
import { readFileSync } from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../../docs/protocol/fixtures/slack-handoff.json',import.meta.url),'utf8'));
const auth={ok:true,team_id:'TTEST',user_id:'UTEST',team:'Test',url:'https://test.slack.com/'};
const candidate={teamId:'TTEST',token:'xoxc-synthetic'},session={cookie:'xoxd-original%2Bbytes%3D',expiresAt:fixture.now+3600000};
test('Slack boundary rejects deceptive domains, credentials, ports and non-client pages',()=>{
 for(const url of ['https://evilslack.com/client/TTEST','https://test.slack.com.evil/client/TTEST','https://x.y.slack.com/client/TTEST','http://test.slack.com/client/TTEST','https://u@test.slack.com/client/TTEST','https://test.slack.com:444/client/TTEST','https://slack.com/signin'])assert.equal(slackUrl(url,true),null);
 assert.ok(slackUrl('https://app.slack.com/client/TTEST',true));
});
test('storage parser admits validated workspace records and one selected boot token',()=>{
 const config=JSON.stringify({teams:{TTEST:{token:'xoxc-synthetic',url:'https://test.slack.com/'},TBAD:{token:'xoxc-bad',url:'https://evilslack.com/'}}});
 assert.deepEqual(candidates('https://app.slack.com/client/TTEST',config,null),[candidate]);
 assert.deepEqual(candidates('https://app.slack.com/client/TTEST','bad','xoxc-boot'),[{teamId:'TTEST',token:'xoxc-boot'}]);
 assert.deepEqual(candidates('https://evil.test/client/TTEST',config,'xoxc-boot'),[]);
});
test('cookie filtering preserves original percent encoding and rejects ambiguity or injection',()=>{
 const c={name:'d',domain:'.slack.com',path:'/',value:session.cookie,secure:true,httpOnly:true,expires:-1};
 assert.equal(sessionCookie([c],'https://app.slack.com/client/TTEST',fixture.now).cookie,session.cookie);
 for(const patch of [{domain:'.evilslack.com'},{secure:false},{httpOnly:false},{value:'xoxd-a; injected=b'},{expires:fixture.now/1000}])assert.equal(sessionCookie([{...c,...patch}],'https://app.slack.com/client/TTEST',fixture.now),null);
 assert.equal(sessionCookie([c,c],'https://app.slack.com/client/TTEST',fixture.now),null);
});
test('runtime navigation guard refuses storage access after a cross-origin navigation',()=>{
 let accessed=false;const context={URL,location:{href:'https://evil.test/client/TTEST'},localStorage:{getItem(){accessed=true;throw new Error();}},document:{scripts:[]}};
 assert.equal(runInNewContext(snapshotExpression,context),null);assert.equal(accessed,false);
 context.location.href='https://app.slack.com/client/TTEST';context.localStorage.getItem=()=>'{"teams":{}}';context.document.scripts=[{textContent:'{"api_token":"xoxc-boot"}'}];const result=runInNewContext(snapshotExpression,context);assert.equal(result.bootToken,'xoxc-boot');
});
test('collector validates token-cookie pair only against fixed API and exposes no secrets in state',async()=>{
 const collector=new SessionCollector(async(url,init)=>{assert.equal(url,'https://slack.com/api/auth.test');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.headers.Cookie,'d='+session.cookie);return Response.json(auth);},()=>fixture.now);
 await collector.accept(candidate,session);assert.deepEqual(collector.state(),{ready:true,workspaces:[{id:'TTEST',label:'Test'}]});assert.ok(collector.seal(fixture.pairingCode,'TTEST').startsWith('rvslack1.'));assert.throws(()=>collector.seal(fixture.pairingCode,'TOTHER'),BridgeError);collector.close();assert.throws(()=>collector.seal(fixture.pairingCode,'TTEST'),BridgeError);
});
test('wrong workspace and raw proxy errors never become a transferable session',async()=>{
 for(const response of [Response.json({...auth,team_id:'TOTHER'}),new Response('secret raw body',{status:401}),Response.json({ok:false,error:'secret raw error'})]){
  const collector=new SessionCollector(async()=>response,()=>fixture.now);await assert.rejects(collector.accept(candidate,session),e=>e instanceof BridgeError&&!e.message.includes('secret'));assert.equal(collector.state().ready,false);
 }
});
test('closing during validation aborts requests and fences a late completion',async()=>{
 let resolve,signal;const collector=new SessionCollector(async(_u,init)=>{signal=init.signal;return new Promise(r=>{resolve=r;});},()=>fixture.now);const pending=collector.accept(candidate,session);collector.close();assert.equal(signal.aborted,true);resolve(Response.json(auth));await assert.rejects(pending,BridgeError);assert.equal(collector.state().ready,false);
});
test('expiry and malformed public keys refuse export',async()=>{
 let now=fixture.now;const collector=new SessionCollector(async()=>Response.json(auth),()=>now);await collector.accept(candidate,session);
 for(const key of ['not-a-key',fixture.pairingCode+'=', 'A'.repeat(43)])assert.throws(()=>collector.seal(key,'TTEST'),BridgeError);
 now+=3600000;assert.equal(collector.state().ready,false);assert.throws(()=>collector.seal(fixture.pairingCode,'TTEST'),BridgeError);
});
test('sealed output contains neither raw cookie nor token and is provider-separated',()=>{const code=sealSession(fixture.pairingCode,fixture.body);assert.ok(code.startsWith('rvslack1.'));assert.ok(!code.includes(session.cookie));assert.ok(!code.includes(candidate.token));});

test('workspace storage accepts explicit IDs and domain-only records in array form',()=>{const config=JSON.stringify({teams:[{id:'TTEST',domain:'test',token:'xoxc-synthetic'},{id:'TBAD',domain:'evil.test',token:'xoxc-bad'}]});assert.deepEqual(candidates('https://app.slack.com/client/TTEST',config,null),[candidate]);});
