import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync,sign } from 'node:crypto';
import { teamsTokenRequest } from './browser.mjs';
import { SessionCollector,BridgeError,tokenRequest,verifyIdentity } from './session.mjs';
import { Pairing } from '../../apps/mobile/providers/teams/handoff.ts';
const now=Date.now(),tid='00000000-0000-0000-0000-000000000001',oid='00000000-0000-0000-0000-000000000002',client='00000000-0000-0000-0000-000000000003';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key',use:'sig',alg:'RS256'};
const fetcher=async(url,options)=>{assert.equal(url,'https://login.microsoftonline.com/common/discovery/v2.0/keys');assert.equal(options.redirect,'error');return new Response(JSON.stringify({keys:[jwk]}));};
function idToken(patch={},header={}){const parts=[{alg:'RS256',kid:'synthetic-key',...header},{ver:'2.0',tid,oid,aud:client,iss:'https://login.microsoftonline.com/'+tid+'/v2.0',exp:Math.floor(now/1000)+3600,nbf:Math.floor(now/1000)-30,iat:Math.floor(now/1000)-30,...patch}].map(o=>Buffer.from(JSON.stringify(o)).toString('base64url'));return parts.join('.')+'.'+sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url');}
function request(audience='spaces'){return {audience,clientId:client,authority:tid};}
const response=(patch={})=>({token_type:'Bearer',access_token:'opaque-synthetic-token',expires_in:3600,id_token:idToken(),...patch});
test('only Microsoft v2 token requests for one known resource are candidates',()=>{
  const post='client_id='+client+'&scope='+encodeURIComponent('https://api.spaces.skype.com/.default openid profile offline_access');assert.equal(tokenRequest('https://login.microsoftonline.com/'+tid+'/oauth2/v2.0/token',post).audience,'spaces');
  for(const url of ['http://login.microsoftonline.com/'+tid+'/oauth2/v2.0/token','https://evil.test/'+tid+'/oauth2/v2.0/token','https://login.microsoftonline.com.evil.test/'+tid+'/oauth2/v2.0/token'])assert.equal(tokenRequest(url,post),null);
  assert.equal(tokenRequest('https://login.microsoftonline.com/'+tid+'/oauth2/v2.0/token',post+'&scope=unknown'),null);
});
test('signed identity checks issuer, audience, tenant, algorithm and expiry',async()=>{
  assert.equal((await verifyIdentity(idToken(),request(),fetcher,now)).accountId,oid);
  for(const [patch,header]of [[{iss:'https://evil.test/'},{}],[{aud:'other'},{}],[{tid:'invalid'},{}],[{exp:Math.floor(now/1000)-1},{}],[{nbf:Math.floor(now/1000)+1000},{}],[{}, {alg:'none'}]])await assert.rejects(verifyIdentity(idToken(patch,header),request(),fetcher,now),BridgeError);
  const forged=idToken().split('.');forged[2]=Buffer.alloc(256).toString('base64url');await assert.rejects(verifyIdentity(forged.join('.'),request(),fetcher,now),BridgeError);
});
test('one verified identity across all audiences produces only encrypted, short-lived handoffs',async()=>{
  const c=new SessionCollector(fetcher,()=>now);assert.equal(c.state().ready,false);assert.throws(()=>c.seal(Buffer.alloc(32,7).toString('base64url')),BridgeError);
  for(const a of ['spaces','aggregator','chat'])await c.accept(request(a),response({access_token:'opaque-'+a}));assert.equal(c.state().ready,true);
  const recipient=new Pairing(),key=recipient.code(),code=c.seal(key);assert.ok(!code.includes('opaque-'));const value=recipient.open(code,now);assert.equal(value.tokens.chat,'opaque-chat');assert.equal(value.account.accountId,oid);assert.equal(Object.keys(value.tokens).length,3);
  c.close();assert.throws(()=>c.seal(key),e=>e.code==='cancelled');
});
test('missing identity result, account switches and client switches cannot export old sessions',async()=>{
  const c=new SessionCollector(fetcher,()=>now);await assert.rejects(c.accept(request(),response({id_token:undefined})),e=>e.code==='identity_result_missing');await c.accept(request(),response());
  await assert.rejects(c.accept(request('chat'),response({id_token:idToken({oid:'00000000-0000-0000-0000-000000000004'})})),e=>e.code==='account_changed');assert.equal(c.state().ready,false);assert.throws(()=>c.seal(Buffer.alloc(32,7).toString('base64url')),BridgeError);
});
test('closing while verification is pending discards its late grant',async()=>{
  let finish;const c=new SessionCollector(()=>new Promise(r=>{finish=r;}),()=>now);const pending=c.accept(request(),response());c.close();finish(new Response(JSON.stringify({keys:[jwk]})));await assert.rejects(pending,e=>e.code==='cancelled');assert.equal(c.state().ready,false);
});

test('browser capture ignores token requests from any document outside Teams',()=>{
  const request={url:'https://login.microsoftonline.com/'+tid+'/oauth2/v2.0/token',postData:'client_id='+client+'&scope='+encodeURIComponent('https://api.spaces.skype.com/.default')};
  assert.equal(teamsTokenRequest({documentURL:'https://teams.microsoft.com/v2/',request}).audience,'spaces');
  for(const documentURL of ['https://evil.test/','https://teams.microsoft.com.evil.test/','https://login.microsoftonline.com/','about:blank'])assert.equal(teamsTokenRequest({documentURL,request}),null);
});
