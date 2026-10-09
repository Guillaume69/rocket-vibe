import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackReader, SlackError, compareTimestamp, validateCredentials } from './client.ts';
const token='xoxc-synthetic', cookie='xoxd-original%2Bbytes%3D';
const auth={ok:true,team_id:'TTEST',user_id:'UTEST',team:'Test',user:'test',url:'https://test.slack.com/'};
const json=(body:unknown,status=200,headers:Record<string,string>={}) => new Response(JSON.stringify(body),{status,headers});
test('token and original cookie accompany form reads at the fixed origin',async () => {
  const calls:{url:string;body:string}[]=[];
  const reader=new SlackReader(token,cookie,async (url,init) => {
    assert.equal(init?.redirect,'error'); const h=new Headers(init?.headers);
    assert.equal(h.get('Cookie'),'d='+cookie); assert.equal(h.get('Authorization'),'Bearer '+token);
    calls.push({url:String(url),body:String(init?.body)});
    return json(calls.length===1?auth:{ok:true,channels:[],response_metadata:{next_cursor:'opaque+/='}});
  });
  assert.equal((await reader.authenticate()).key,'slack:TTEST:UTEST');
  assert.equal((await reader.conversations()).nextCursor,'opaque+/=');
  await reader.conversations('opaque+/=');
  assert.ok(calls.every(c => c.url.startsWith('https://slack.com/api/')));
  assert.equal(new URLSearchParams(calls[2].body).get('cursor'),'opaque+/='); reader.close();
});
test('credentials reject header injection and preserve percent encoding',() => {
  validateCredentials(token,cookie);
  for(const bad of ['xoxd-a; other=b','xoxd-a\r\nX: y','xoxd-a b','xoxd-a,b','xoxd-a\\b','d=xoxd-a']) assert.throws(()=>validateCredentials(token,bad),SlackError);
  assert.throws(()=>validateCredentials('xoxc-a\n',cookie),SlackError);
});
test('proxy failures and invalid envelopes are safe errors without raw bodies',async () => {
  for(const response of [new Response('private secret',{status:401}),new Response('<html>private secret</html>'),json({ok:false,error:'private secret'}),json({team_id:'TTEST'})]) {
    const reader=new SlackReader(token,cookie,async()=>response);
    await assert.rejects(reader.authenticate(),e=>e instanceof SlackError && !e.message.includes('private secret'));
  }
});
test('429 retains retry delay and never automatically repeats',async () => {
  let calls=0; const reader=new SlackReader(token,cookie,async()=>{calls++;return json({},429,{'retry-after':'27'});});
  await assert.rejects(reader.authenticate(),e=>e instanceof SlackError&&e.code==='ratelimited'&&e.retryAfter===27); assert.equal(calls,1);
});
test('identity validates workspace boundary and cannot change within a reader',async () => {
  for(const url of ['https://evilslack.com/','https://test.slack.com.evil.test/','http://test.slack.com/','https://user@test.slack.com/','https://test.slack.com:444/']) {
    await assert.rejects(new SlackReader(token,cookie,async()=>json({...auth,url})).authenticate(),SlackError);
  }
  let first=true; const reader=new SlackReader(token,cookie,async()=>{ const body=first?auth:{...auth,team_id:'TOTHER'};first=false;return json(body); });
  await reader.authenticate(); await assert.rejects(reader.authenticate(),e=>e instanceof SlackError&&e.code==='identity_changed');
});
test('history keeps same-millisecond identities and microsecond ordering',async () => {
  assert.equal(compareTimestamp('9.999999','10.000000'),-1);
  let n=0; const reader=new SlackReader(token,cookie,async()=>json(++n===1?auth:{ok:true,messages:[{ts:'1780000000.000001',text:'a'},{ts:'1780000000.000009',text:'b',thread_ts:'1780000000.000001'}],has_more:true,response_metadata:{next_cursor:'next'}}));
  await reader.authenticate(); const page=await reader.history('CTEST');
  assert.deepEqual(page.items.map(m=>m.ts),['1780000000.000009','1780000000.000001']); assert.equal(page.nextCursor,'next');
});
test('unknown paging contract refuses silently truncated history',async () => {
  let n=0; const reader=new SlackReader(token,cookie,async()=>json(++n===1?auth:{ok:true,messages:[],has_more:true}));
  await reader.authenticate(); await assert.rejects(reader.history('CTEST'),e=>e instanceof SlackError&&e.code==='pagination_unsupported');
});
test('closing aborts in-flight reads and discards late success',async () => {
  let signal:AbortSignal|undefined, resolve!:(r:Response)=>void;
  const reader=new SlackReader(token,cookie,async(_url,init)=>{signal=init?.signal ?? undefined;return new Promise<Response>(r=>{resolve=r;});});
  const pending=reader.authenticate(); reader.close(); assert.equal(signal?.aborted,true); resolve(json(auth));
  await assert.rejects(pending,e=>e instanceof SlackError&&e.code==='cancelled'); await assert.rejects(reader.authenticate(),SlackError);
});
