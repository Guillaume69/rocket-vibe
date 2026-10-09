import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TeamsError, accountKey, discoverRoutes, historyUrl, parseSnapshot, parseHistory, validateBackwardLink, TEAMS_CAPABILITIES } from './protocol.ts';
import { TeamsReader } from './reader.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/fixtures/teams-read.json',import.meta.url),'utf8'));
const routes=discoverRoutes(fixture.authz), account=fixture.account;
const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
const tokens={spaces:'synthetic-spaces',aggregator:'synthetic-aggregator',chat:'synthetic-chat'};
test('discovery accepts only qualified global proxy roles and discards unrelated secrets',()=>{
  assert.deepEqual(discoverRoutes({...fixture.authz,tokens:{skypeToken:'do-not-retain'}}),routes);
  for(const route of ['http://teams.microsoft.com/api/chatsvc/fr','https://teams.microsoft.com.evil.test/api/chatsvc/fr','https://evil.test/api/chatsvc/fr','https://user@teams.microsoft.com/api/chatsvc/fr','https://teams.microsoft.com/api/csa/fr','https://teams.microsoft.com/api/chatsvc/fr?extra=1','https://teams.microsoft.com/api/chatsvc/fr#extra','https://teams.microsoft.com:444/api/chatsvc/fr','https://teams.microsoft.com/api/chatsvc/fr/other']) {
    assert.throws(()=>discoverRoutes({regionGtms:{...fixture.authz.regionGtms,chatServiceAfd:route}}),TeamsError);
  }
  assert.throws(()=>discoverRoutes({regionGtms:{chatService:'https://teams.microsoft.com/api/chatsvc/fr'}}),TeamsError);
});
test('opaque conversation is one component and older links cannot switch service or context',()=>{
  assert.equal(new URL(historyUrl(routes,fixture.conversation)).pathname,routes.chat.replace('https://teams.microsoft.com','')+'/v1/users/ME/conversations/19%3Achat%2Fopaque%40test/messages');
  const next=fixture.history._metadata.backwardLink;
  assert.equal(validateBackwardLink(next,routes,fixture.conversation),next);
  for(const bad of [next.replace('teams.microsoft.com','evil.test'),next.replace('19%3Achat%2Fopaque%40test','19%3Aother%40test'),next.replace('/messages?','/properties?'),next.replace('/chatsvc/','/csa/')]) assert.throws(()=>validateBackwardLink(bad,routes,fixture.conversation),TeamsError);
  assert.throws(()=>historyUrl(routes,'..'),TeamsError);
});
test('tenant, account, conversation and root scope isolate exact server IDs',()=>{
  const page=parseHistory(fixture.history,account,routes,fixture.conversation), m=page.items[0];
  assert.equal(m.id,'9007199254740993'); assert.equal(m.version,'9007199254740995'); assert.equal(m.rootId,'9007199254740992'); assert.equal(m.format,'html'); assert.equal(m.arrivedAt,'2026-10-09T10:00:00.1234567Z');
  assert.equal(page.items[1].format,'unsupported'); assert.equal(page.items[1].content,'');
  assert.notEqual(accountKey(account),accountKey({...account,tenantId:'00000000-0000-0000-0000-000000000002'}));
  assert.notEqual(m.key,parseHistory({...fixture.history,_metadata:{}},account,routes,'another-chat').items[0].key);
  for(const patch of [{id:9007199254740992},{version:123},{originalarrivaltime:'2026-02-31T00:00:00Z'},{originalarrivaltime:'yesterday'}]) assert.throws(()=>parseHistory({messages:[{...fixture.history.messages[0],...patch}]},account,routes,fixture.conversation),TeamsError);
});
test('classification uses explicit type and keeps unfamiliar types unsupported',()=>{
  assert.deepEqual(parseSnapshot(fixture.snapshot).map(r=>r.kind),['direct','unsupported','channel']);
  assert.ok(Object.values(TEAMS_CAPABILITIES).every(enabled=>enabled===false));
});
test('read requests select one audience, suppress cookies and never decode tokens',async()=>{
  const calls:string[]=[];
  const reader=new TeamsReader(account,tokens,async(url,init)=>{
    const u=String(url);calls.push(u);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
    const expected=u.includes('/authsvc/')?tokens.spaces:u.includes('/csa/')?tokens.aggregator:tokens.chat;
    const h=new Headers(init?.headers);assert.equal(h.get('Authorization'),'Bearer '+expected);assert.equal(h.get('Cookie'),null);
    if(u.includes('/authsvc/')){assert.equal(init?.method,'POST');assert.equal(init?.body,'');return json(fixture.authz);}
    assert.equal(init?.method,'GET');return json(u.includes('/csa/')?fixture.snapshot:fixture.history);
  });
  await assert.rejects(reader.conversations(),e=>e instanceof TeamsError&&e.code==='discovery_required');
  await reader.discover();await reader.conversations();await reader.history(fixture.conversation);
  await assert.rejects(reader.history(fixture.conversation,'https://evil.test/'),TeamsError);assert.equal(calls.length,3);reader.close();
});
test('permissions, proxy bodies and throttling expose only sanitized errors without retry',async()=>{
  for(const status of [401,403,429,500]){
    let n=0;const reader=new TeamsReader(account,tokens,async()=>{n++;return new Response('private-secret',{status,headers:{'retry-after':'27'}});});
    await assert.rejects(reader.discover(),e=>e instanceof TeamsError&&!e.message.includes('private-secret')&&e.status===status&&(status!==429||e.retryAfter===27));assert.equal(n,1);reader.close();
  }
});
test('close aborts and rejects a late successful discovery',async()=>{
  let resolve!:(r:Response)=>void, signal:AbortSignal|undefined;
  const reader=new TeamsReader(account,tokens,async(_url,init)=>{signal=init?.signal??undefined;return new Promise(r=>{resolve=r;});});
  const pending=reader.discover();reader.close();assert.equal(signal?.aborted,true);resolve(json(fixture.authz));
  await assert.rejects(pending,e=>e instanceof TeamsError&&e.code==='cancelled');await assert.rejects(reader.conversations(),TeamsError);
});

test('latest discovery wins and regional changes replace both routes atomically',async()=>{
  const resolvers:((r:Response)=>void)[]=[];const targets:string[]=[];
  const reader=new TeamsReader(account,tokens,async(url)=>{
    const target=String(url);targets.push(target);
    if(target.includes('/authsvc/')) return new Promise(r=>{resolvers.push(r);});
    return json(fixture.snapshot);
  });
  const older=reader.discover(), latest=reader.discover();
  resolvers[1](json({regionGtms:{chatSvcAggAfd:'https://teams.microsoft.com/api/csa/next-region',chatServiceAfd:'https://teams.microsoft.com/api/chatsvc/next-region'}}));await latest;
  resolvers[0](json(fixture.authz));await assert.rejects(older,e=>e instanceof TeamsError&&e.code==='superseded_discovery');
  await reader.conversations();assert.ok(targets[2].includes('/csa/next-region/'));reader.close();
});
test('equivalent path encoding is accepted without decoding slashes into components',()=>{
  const next=fixture.history._metadata.backwardLink;
  assert.equal(validateBackwardLink(next.replace('19%3A','19:').replace('%40test','@test'),routes,fixture.conversation),next.replace('19%3A','19:').replace('%40test','@test'));
  assert.throws(()=>validateBackwardLink(next.replace('%2Fopaque','/opaque'),routes,fixture.conversation),TeamsError);
});
test('missing audience credentials and oversized response are diagnosed',async()=>{
  assert.throws(()=>new TeamsReader(account,{...tokens,chat:''}),TeamsError);
  const reader=new TeamsReader(account,tokens,async()=>new Response('x'.repeat(2_000_001)));
  await assert.rejects(reader.discover(),e=>e instanceof TeamsError&&e.code==='response_too_large');reader.close();
});
