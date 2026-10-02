import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import {NativeStore} from './store.ts';
import {NativeChat} from './chat.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import type {ReadState,Snapshot} from './protocol.generated.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function socket():WebSocket {
  const result={onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  queueMicrotask(()=>result.onopen?.(new Event('open')));return result;
}
function snapshot():Snapshot {
  return {protocol_version:1,cursor:'initial',rooms:[{...fixture.room,read_state:{room_id:'room-id',revision:'10',favorite_revision:'9',membership_version:'membership',root_position:'0',reply_position:'0',unread_roots:'2',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}}],messages:[{...fixture.message,id:'observed',position:'9007199254740993'},{...fixture.message,id:'newest',position:'9007199254740994'}]};
}
async function body(request:IncomingMessage):Promise<Record<string,unknown>> {const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function send(response:ServerResponse,status:number,value:unknown):void {response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));}
async function fixtureServer(handler:(request:IncomingMessage,response:ServerResponse,path:string)=>Promise<boolean>){
  const errors:unknown[]=[];
  const server=createServer((request,response)=>{void(async()=>{
    const path=new URL(request.url!,'http://localhost').pathname;
    if(path==='/.well-known/rocketvibe'){send(response,200,{...fixture.discovery,capabilities:{...fixture.discovery.capabilities,read_markers:true,favorites:true}});return;}
    assert.equal(request.headers.authorization,'Bearer fixture-token');
    if(path==='/api/v1/me'){send(response,200,fixture.session.user);return;}
    if(path==='/api/v1/sync/changes'){send(response,200,{protocol_version:1,changes:[],cursor:'initial',has_more:false});return;}
    if(path==='/api/v1/sync/ticket'){send(response,200,fixture.socket_ticket);return;}
    if(!await handler(request,response,path))send(response,404,{code:'not_found',request_id:'fixture'});
  })().catch(error=>{errors.push(error);send(response,500,{code:'fixture_failure',request_id:'fixture'});});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw new Error('No listener');
  const session:Session={baseUrl:`http://127.0.0.1:${address.port}`,authToken:'fixture-token',userId:'alice-id',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  return {session,errors,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
function disk(){const directory=mkdtempSync(join(tmpdir(),'rv-state-runner-'));return {filename:join(directory,'account.sqlite'),clean(){unlinkSync(join(directory,'account.sqlite'));rmdirSync(directory);}};}

test('actual HTTP lost read and favorite acks recover original disk intentions without new writes',async()=>{
  let favoriteWrites=0,readWrites=0;const reads:string[]=[];let current:ReadState={...snapshot().rooms[0].read_state!};
  const http=await fixtureServer(async(request,response,path)=>{
    if(path==='/api/v1/rooms/room-id/commands/original'){send(response,favoriteWrites?200:404,favoriteWrites?{operation_id:'original',room_id:'room-id',applied_revision:'12'}:{code:'not_found',request_id:'fixture'});return true;}
    if(path==='/api/v1/rooms/room-id/favorite'){
      const input=await body(request);assert.deepEqual(input,{operation_id:'original',expected_revision:'9',present:true});favoriteWrites++;
      current={...current,revision:'12',favorite_revision:'12',favorite:true};response.destroy();return true;
    }
    if(path==='/api/v1/rooms/room-id/read'){
      if(request.method==='POST'){const input=await body(request);assert.equal(input.reply_position,'0');reads.push(String(input.root_position));readWrites++;current={...current,root_position:String(input.root_position),revision:'13'};response.destroy();}
      else send(response,200,current);return true;
    }
    return false;
  });
  const files=disk();let harness=nativeTestDatabase(files.filename),store=new NativeStore(harness.adapter,creerFileEcritures(),http.session);
  let chat=new NativeChat(http.session,store,()=>{throw new Error('No replacement ID');},{socket});
  try{
    await store.applySnapshot(snapshot());await store.stageRead('room-id','observed');await store.stageFavorite('room-id',true,()=> 'original');await chat.connect();
    assert.equal(chat.status.online,true);assert.equal((await store.pendingReads()).length,1);assert.equal((await store.pendingFavorites()).length,1);
    chat.stop();await store.state();harness.db.close();
    current={...current,revision:'14',favorite_revision:'14',favorite:false};
    harness=nativeTestDatabase(files.filename,false);store=new NativeStore(harness.adapter,creerFileEcritures(),http.session);chat=new NativeChat(http.session,store,()=>{throw new Error('Recovery nonce forbidden');},{socket});
    await chat.connect();assert.deepEqual(await store.pendingReads(),[]);assert.deepEqual(await store.pendingFavorites(),[]);
    assert.equal((await store.readState('room-id'))?.favorite,false);assert.deepEqual(reads,['9007199254740993']);assert.equal(readWrites,1);assert.equal(favoriteWrites,1);assert.deepEqual(http.errors,[]);
  }finally{chat.stop();await store.state();harness.db.close();files.clean();await http.close();}
});

test('confirmed receipt survives a failed state fetch; restart reads latest state without PUT or receipt retry',async()=>{
  let writes=0,receipts=0,allowState=false;
  const http=await fixtureServer(async(request,response,path)=>{
    if(path==='/api/v1/rooms/room-id/commands/original'){receipts++;send(response,404,{code:'not_found',request_id:'fixture'});return true;}
    if(path==='/api/v1/rooms/room-id/favorite'){assert.equal((await body(request)).operation_id,'original');writes++;send(response,200,{operation_id:'original',room_id:'room-id',applied_revision:'12'});return true;}
    if(path==='/api/v1/rooms/room-id/read'){send(response,allowState?200:503,allowState?{...snapshot().rooms[0].read_state!,revision:'14',favorite_revision:'14',favorite:false}:{code:'temporarily_unavailable',request_id:'fixture'});return true;}
    return false;
  });
  const files=disk();let harness=nativeTestDatabase(files.filename),store=new NativeStore(harness.adapter,creerFileEcritures(),http.session),chat=new NativeChat(http.session,store,()=> 'original',{socket});
  try{
    await store.applySnapshot(snapshot());await chat.connect();await chat.setFavorite('room-id',true);
    assert.equal((await store.favoriteIntent('room-id'))?.phase,'confirmed');chat.stop();await store.state();harness.db.close();allowState=true;
    harness=nativeTestDatabase(files.filename,false);store=new NativeStore(harness.adapter,creerFileEcritures(),http.session);chat=new NativeChat(http.session,store,()=>{throw new Error('No retry nonce');},{socket});await chat.connect();
    assert.equal(await store.favoriteIntent('room-id'),null);assert.equal(writes,1);assert.equal(receipts,1);assert.equal((await store.readState('room-id'))?.favorite,false);assert.deepEqual(http.errors,[]);
  }finally{chat.stop();await store.state();harness.db.close();files.clean();await http.close();}
});

test('read quota leaves socket online and permits favorites and sends while preserving newest observed target',async()=>{
  let readWrites=0,favorites=0,sends=0;let current:ReadState={...snapshot().rooms[0].read_state!};
  const http=await fixtureServer(async(request,response,path)=>{
    if(path==='/api/v1/rooms/room-id/read'){
      if(request.method==='POST'){readWrites++;response.setHeader('retry-after','60');send(response,429,{code:'rate_limited',request_id:'read-quota'});}else send(response,200,current);return true;
    }
    if(path==='/api/v1/rooms/room-id/favorite'){const input=await body(request);favorites++;current={...current,revision:'20',favorite_revision:'20',favorite:true};send(response,200,{operation_id:input.operation_id,room_id:'room-id',applied_revision:'20'});return true;}
    if(path==='/api/v1/rooms/room-id/messages'){const input=await body(request);sends++;send(response,200,{...fixture.message,id:input.operation_id,text:input.text,position:'9007199254740995',revision:'21'});return true;}
    return false;
  });
  const harness=nativeTestDatabase(),store=new NativeStore(harness.adapter,creerFileEcritures(),http.session);let id=0;const chat=new NativeChat(http.session,store,()=> `operation-${++id}`,{socket});
  try{
    await store.applySnapshot(snapshot());await chat.connect();await chat.markObservedRead('room-id','observed');assert.equal(chat.status.online,true);
    await chat.markObservedRead('room-id','newest');await chat.setFavorite('room-id',true);await chat.send('room-id','Quota does not block this');
    assert.equal(readWrites,1);assert.equal(favorites,1);assert.equal(sends,1);assert.equal(chat.status.online,true);assert.equal((await store.pendingReads())[0].root_position,'9007199254740994');assert.deepEqual(http.errors,[]);
  }finally{chat.stop();await store.state();harness.db.close();await http.close();}
});

test('favorite runner rejects foreign receipts and lifetime changes, preserving exact failed forms',async()=>{
  for(const scenario of ['foreign','rejoin','closed','conflict'] as const){
    let store:NativeStore,chat:NativeChat,writes=0;
    const http=await fixtureServer(async(request,response,path)=>{
      if(path==='/api/v1/rooms/room-id/commands/original'){
        if(scenario==='foreign'){send(response,200,{operation_id:'original',room_id:'another-room',applied_revision:'12'});return true;}
        if(scenario==='rejoin'){
          const next=snapshot().rooms[0];next.read_state={...next.read_state!,revision:'20',membership_version:'new-membership'};
          await store.applyBatch({protocol_version:1,cursor:'rejoined',has_more:false,changes:[{type:'room_upsert',data:next}]});
        }
        if(scenario==='closed')chat.stop();
        send(response,404,{code:'not_found',request_id:'fixture'});return true;
      }
      if(path==='/api/v1/rooms/room-id/favorite'){await body(request);writes++;send(response,409,{code:'revision_conflict',request_id:'fixture'});return true;}
      return false;
    });
    const harness=nativeTestDatabase();store=new NativeStore(harness.adapter,creerFileEcritures(),http.session);chat=new NativeChat(http.session,store,()=> 'original',{socket});
    try{
      await store.applySnapshot(snapshot());await chat.connect();await chat.setFavorite('room-id',true);
      const saved=await store.favoriteIntent('room-id');assert.equal(writes,scenario==='conflict'?1:0);
      if(scenario==='rejoin')assert.equal(saved,null);else assert.equal(saved?.phase,scenario==='conflict'?'failed':'pending');
      assert.equal((await store.readState('room-id'))?.favorite,false);
      if(scenario==='conflict'){assert.equal(saved?.input.expected_revision,'9');assert.equal(await chat.dismissFailedFavorite('room-id','wrong-id'),false);assert.equal(await chat.dismissFailedFavorite('room-id','original'),true);}
      assert.deepEqual(http.errors,[]);
    }finally{chat.stop();await store.state();harness.db.close();await http.close();}
  }
});
