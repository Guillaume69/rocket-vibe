import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ClientRest} from './rest.ts';
import {appelDisponibleMemo,contexteAppel,definirAppelsFournisseur,demarrerConference,rejoindreConference,sonderAppelDisponible,type AppelsNatifs} from './appel.ts';

test('existing Rocket.Chat call endpoints and media state remain unchanged',async()=>{
  const requests:{path:string;method:string;body:unknown}[]=[];
  const client=new ClientRest('https://chat.example.test',{fetch:async(url,options)=>{
    const path=String(url).split('/api/v1/')[1];requests.push({path,method:options!.method!,body:options!.body?JSON.parse(String(options!.body)):null});
    return Response.json(path==='video-conference.start'?{data:{callId:'legacy-call'},success:true}:path==='video-conference.join'?{url:'https://jitsi.example.test/legacy',success:true}:{success:true});
  }});
  const detach=definirAppelsFournisseur(client,null);
  try{
    assert.equal(await sonderAppelDisponible(client),true);assert.equal(await sonderAppelDisponible(client),true);
    assert.equal(await demarrerConference(client,'room'),'legacy-call');
    assert.equal(await rejoindreConference(client,'legacy-call',{cam:false,mic:true}),'https://jitsi.example.test/legacy');
    assert.deepEqual(requests,[{path:'video-conference.capabilities',method:'GET',body:null},{path:'video-conference.start',method:'POST',body:{roomId:'room'}},{path:'video-conference.join',method:'POST',body:{callId:'legacy-call',state:{cam:false,mic:true}}}]);
  }finally{detach();}
});

test('Rocket.Chat availability belongs to an account client and uncertain failures can be retried',async()=>{
  let calls=0,status=503;
  const fetcher:typeof fetch=async()=>{calls++;return status===200?Response.json({success:true}):Response.json({success:false,error:'Unavailable'},{status});};
  const client=new ClientRest('https://chat.example.test',{fetch:fetcher,dormir:async()=>{},alea:()=>0});
  assert.equal(await sonderAppelDisponible(client),false);status=429;
  assert.equal(await sonderAppelDisponible(client),false);status=200;
  assert.equal(await sonderAppelDisponible(client),true);const previous=calls;
  assert.equal(await sonderAppelDisponible(client),true);assert.equal(calls,previous);
  const other=new ClientRest(client.baseUrl,{fetch:async()=>Response.json({success:false,error:'no-videoconf-provider-app'},{status:400})});
  assert.equal(await sonderAppelDisponible(other),false);assert.equal(appelDisponibleMemo(client),true);assert.equal(appelDisponibleMemo(other),false);
});

test('native call callbacks are fenced by provider mount and visible view, including reused clients',async()=>{
  const client=new ClientRest('https://native.example.test',{fetch:async()=>{throw new Error('Unexpected Rocket.Chat request');}});client.genre='rocketvibe';
  let release:(value:string)=>void=()=>{},entered:()=>void=()=>{},alive:()=>boolean=()=>false;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const calls:AppelsNatifs={disponible:async()=>true,memo:()=>true,demarrer:async(room,membership,current)=>{
    assert.equal(room,'room');assert.equal(membership,'grant');alive=current;entered();return new Promise<string>(resolve=>{release=resolve;});
  },rejoindre:async()=> 'https://meet.example.test/conference?jwt=a.b.c'};
  const detach=definirAppelsFournisseur(client,calls),before=contexteAppel(client);
  assert.equal(await sonderAppelDisponible(client,'room','grant'),true);
  const pending=demarrerConference(client,'room',{membership:'grant'});await started;assert(alive());
  const current=definirAppelsFournisseur(client,{...calls,demarrer:async()=> 'fresh'});
  detach();assert.notEqual(contexteAppel(client),before);assert.equal(alive(),false);release('old');
  await assert.rejects(pending,/call_scope_closed/);assert.equal(await demarrerConference(client,'room'),'fresh');
  await assert.rejects(rejoindreConference(client,'meeting',undefined,{alive:()=>false}),/call_scope_closed/);
  current();assert.equal(appelDisponibleMemo(client),false);assert.equal(await sonderAppelDisponible(client),false);
  await assert.rejects(demarrerConference(client,'room'),/call_provider_unavailable/);
});

test('late availability response cannot seed a replacement provider cache',async()=>{
  let release:(response:Response)=>void=()=>{};
  const client=new ClientRest('https://chat.example.test',{fetch:async()=>new Promise<Response>(resolve=>{release=resolve;})});
  const old=definirAppelsFournisseur(client,null),pending=sonderAppelDisponible(client);
  const current=definirAppelsFournisseur(client,null);old();release(Response.json({success:true}));
  assert.equal(await pending,false);assert.equal(appelDisponibleMemo(client),false);current();
});
