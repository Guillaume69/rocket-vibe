import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import {NativeStore} from './store.ts';
import {NativeChat} from './chat.ts';
import {NativeError,NativeTransport} from './transport.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {decodeNative} from './validation.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const discovery=decodeNative('Discovery',fixture.discovery),room=decodeNative('Room',fixture.room),user=decodeNative('User',fixture.session.user);
const snapshot={protocol_version:1,rooms:[room],messages:[],cursor:'initial'};
const settings={expected_revision:'original-revision',name:'Room',private:true,topic:'Private subject',description:'',announcement:'',read_only:false};
function socket():WebSocket {
  const result={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
  queueMicrotask(()=>result.onopen?.(new Event('open')));return result;
}
function account(baseUrl:string):Session{return {baseUrl,authToken:'test-token',userId:user.id,username:user.username,genre:'rocketvibe',siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};}

test('actual HTTP and SQLite recover all room forms after a lost acknowledgement and app restart',async()=>{
  for(const kind of ['settings','role','leave'] as const){
    let applied=0;const requests:{method:string;path:string}[]=[],errors:unknown[]=[];
    const server=createServer((request,response)=>{void(async()=>{
      const path=new URL(request.url!,'http://localhost').pathname,method=request.method!;
      const send=(status:number,body:unknown)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));};
      if(path==='/.well-known/rocketvibe'){send(200,{...discovery,capabilities:{...discovery.capabilities,room_info:true,room_settings:true,room_roles:true,room_leave:true}});return;}
      assert.equal(request.headers.authorization,'Bearer test-token');
      if(path==='/api/v1/me'){send(200,user);return;}
      if(path==='/api/v1/sync/changes'){send(200,{protocol_version:1,changes:[],cursor:'initial',has_more:false});return;}
      if(path==='/api/v1/sync/ticket'){send(200,fixture.socket_ticket);return;}
      if(path.startsWith('/api/v1/rooms/'))requests.push({method,path});
      if(path===`/api/v1/rooms/${room.id}/commands/original`){send(applied?200:404,applied?{operation_id:'original',room_id:room.id,applied_revision:'applied'}:{code:'not_found',request_id:'fixture'});return;}
      if(method!=='GET' && path.startsWith(`/api/v1/rooms/${room.id}`)){
        const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(input.operation_id,'original');assert.equal(input.expected_revision,'original-revision');
        assert.equal(method,kind==='settings'?'PATCH':kind==='role'?'PUT':'POST');
        applied++;response.destroy();return;
      }
      send(404,{code:'not_found',request_id:'fixture'});
    })().catch(error=>{errors.push(error);response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({code:'fixture_failure',request_id:'fixture'}));});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address || typeof address==='string')throw new Error('Fixture listen failed');
    const session=account(`http://127.0.0.1:${address.port}`),directory=mkdtempSync(join(tmpdir(),'rv-room-runner-')),path=join(directory,'account.sqlite');
    let harness=nativeTestDatabase(path),store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    let chat=new NativeChat(session,store,()=> 'original',{socket});
    try{
      await store.applySnapshot(snapshot);await chat.connect();
      const attempt=kind==='settings'?chat.updateRoom(room.id,settings):kind==='role'?chat.changeRoomRole(room.id,user.id,{expected_revision:'original-revision',role:'member'}):chat.leaveRoom(room.id,'original-revision');
      await assert.rejects(attempt);assert.equal((await store.pendingRoomOperations()).length,1);chat.stop();await store.state();harness.db.close();
      harness=nativeTestDatabase(path,false);store=new NativeStore(harness.adapter,creerFileEcritures(),session);
      chat=new NativeChat(session,store,()=>{throw new Error('Recovery must not generate a nonce');},{socket});await chat.connect();
      assert.deepEqual(await store.pendingRoomOperations(),[]);assert.equal(applied,1);
      assert.deepEqual(requests.map(r=>r.method),['GET',kind==='settings'?'PATCH':kind==='role'?'PUT':'POST','GET']);
      assert.deepEqual(errors,[]);
    }finally{chat.stop();await store.state();harness.db.close();unlinkSync(path);rmdirSync(directory);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});

test('room runner preserves ambiguous forms and rejects stale lifetime or mismatched receipts',async()=>{
  for(const scenario of ['conflict','receipt_error','foreign','withdrawn','closed','epoch','quota'] as const){
    const harness=nativeTestDatabase(),session=account('http://localhost:3400'),store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    let changed=false,writes=0;let chat:NativeChat;
    const transport={
      discover:async()=>({...discovery,data_epoch:changed?'replacement':discovery.data_epoch,capabilities:{...discovery.capabilities,room_info:true,room_settings:true}}),
      me:async()=>user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      roomCommandReceipt:async()=>{
        if(scenario==='withdrawn')await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:room.id}}],cursor:'removed',has_more:false});
        if(scenario==='closed')chat.stop();if(scenario==='epoch')changed=true;
        if(scenario==='foreign' || scenario==='epoch')return {operation_id:'original',room_id:scenario==='foreign'?'other':room.id,applied_revision:'applied'};
        throw new NativeError(404,scenario==='receipt_error'?'receipt_hidden':'not_found');
      },
      updateRoom:async()=>{writes++;throw new NativeError(scenario==='quota'?429:409,scenario==='quota'?'rate_limited':'revision_conflict',1);},
    } as unknown as NativeTransport;
    chat=new NativeChat(session,store,()=> 'original',{transport,socket});
    try{
      await store.applySnapshot(snapshot);await chat.connect();const attempt=chat.updateRoom(room.id,settings);
      if(scenario==='withdrawn'){await attempt;assert.equal(await store.roomOperation(room.id),null);}
      else{
        const expected=scenario==='conflict'?'revision_conflict':scenario==='receipt_error'?'receipt_hidden':scenario==='foreign'?'invalid_room_receipt':scenario==='closed'?'session_closed':scenario==='epoch'?'server_identity_changed':'rate_limited';
        await assert.rejects(attempt,(error:unknown)=>error instanceof NativeError && error.code===expected);
        assert.equal((await store.roomOperation(room.id))?.failed,scenario==='conflict'||scenario==='receipt_error',scenario);
      }
      assert.equal(writes,scenario==='conflict'||scenario==='quota'?1:0);
    }finally{chat.stop();await store.state();harness.db.close();}
  }
});
