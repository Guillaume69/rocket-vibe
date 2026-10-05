import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestClient} from './rest.ts';
import {memoizedCallAvailable,callContext,setProviderCalls,startConference,joinConference,probeCallAvailable,type NativeCalls} from './call.ts';

test('existing Rocket.Chat call endpoints and media state remain unchanged',async()=>{
  const requests:{path:string;method:string;body:unknown}[]=[];
  const client=new RestClient('https://chat.example.test',{fetch:async(url,options)=>{
    const path=String(url).split('/api/v1/')[1];requests.push({path,method:options!.method!,body:options!.body?JSON.parse(String(options!.body)):null});
    return Response.json(path==='video-conference.start'?{data:{callId:'legacy-call'},success:true}:path==='video-conference.join'?{url:'https://jitsi.example.test/legacy',success:true}:{success:true});
  }});
  const detach=setProviderCalls(client,null);
  try{
    assert.equal(await probeCallAvailable(client),true);assert.equal(await probeCallAvailable(client),true);
    assert.equal(await startConference(client,'room'),'legacy-call');
    assert.equal(await joinConference(client,'legacy-call',{cam:false,mic:true}),'https://jitsi.example.test/legacy');
    assert.deepEqual(requests,[{path:'video-conference.capabilities',method:'GET',body:null},{path:'video-conference.start',method:'POST',body:{roomId:'room'}},{path:'video-conference.join',method:'POST',body:{callId:'legacy-call',state:{cam:false,mic:true}}}]);
  }finally{detach();}
});

test('Rocket.Chat availability belongs to an account client and uncertain failures can be retried',async()=>{
  let calls=0,status=503;
  const fetcher:typeof fetch=async()=>{calls++;return status===200?Response.json({success:true}):Response.json({success:false,error:'Unavailable'},{status});};
  const client=new RestClient('https://chat.example.test',{fetch:fetcher,sleep:async()=>{},random:()=>0});
  assert.equal(await probeCallAvailable(client),false);status=429;
  assert.equal(await probeCallAvailable(client),false);status=200;
  assert.equal(await probeCallAvailable(client),true);const previous=calls;
  assert.equal(await probeCallAvailable(client),true);assert.equal(calls,previous);
  const other=new RestClient(client.baseUrl,{fetch:async()=>Response.json({success:false,error:'no-videoconf-provider-app'},{status:400})});
  assert.equal(await probeCallAvailable(other),false);assert.equal(memoizedCallAvailable(client),true);assert.equal(memoizedCallAvailable(other),false);
});

test('native call callbacks are fenced by provider mount and visible view, including reused clients',async()=>{
  const client=new RestClient('https://native.example.test',{fetch:async()=>{throw new Error('Unexpected Rocket.Chat request');}});client.kind='rocketvibe';
  let release:(value:string)=>void=()=>{},entered:()=>void=()=>{},alive:()=>boolean=()=>false;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const calls:NativeCalls={available:async()=>true,memo:()=>true,start:async(room,membership,current)=>{
    assert.equal(room,'room');assert.equal(membership,'grant');alive=current;entered();return new Promise<string>(resolve=>{release=resolve;});
  },join:async()=> 'https://meet.example.test/conference?jwt=a.b.c'};
  const detach=setProviderCalls(client,calls),before=callContext(client);
  assert.equal(await probeCallAvailable(client,'room','grant'),true);
  const pending=startConference(client,'room',{membership:'grant'});await started;assert(alive());
  const current=setProviderCalls(client,{...calls,start:async()=> 'fresh'});
  detach();assert.notEqual(callContext(client),before);assert.equal(alive(),false);release('old');
  await assert.rejects(pending,/call_scope_closed/);assert.equal(await startConference(client,'room'),'fresh');
  await assert.rejects(joinConference(client,'meeting',undefined,{alive:()=>false}),/call_scope_closed/);
  current();assert.equal(memoizedCallAvailable(client),false);assert.equal(await probeCallAvailable(client),false);
  await assert.rejects(startConference(client,'room'),/call_provider_unavailable/);
});

test('late availability response cannot seed a replacement provider cache',async()=>{
  let release:(response:Response)=>void=()=>{};
  const client=new RestClient('https://chat.example.test',{fetch:async()=>new Promise<Response>(resolve=>{release=resolve;})});
  const old=setProviderCalls(client,null),pending=probeCallAvailable(client);
  const current=setProviderCalls(client,null);old();release(Response.json({success:true}));
  assert.equal(await pending,false);assert.equal(memoizedCallAvailable(client),false);current();
});
