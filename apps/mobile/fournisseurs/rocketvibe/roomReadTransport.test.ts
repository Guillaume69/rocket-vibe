import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {NativeTransport,NativeError} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
test('personal read state transport keeps exact positions, explicit favorites and private bearer scope',async()=>{
  const calls:{path:string;method:string;body:unknown}[]=[];
  const transport=new NativeTransport('http://localhost:3400',async(url,options)=>{
    assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer fixture-token');
    const path=new URL(String(url)).pathname,method=options?.method??'GET';
    calls.push({path,method,body:options?.body?JSON.parse(String(options.body)):null});
    return Response.json(path.endsWith('/read')?fixture.parity.read_state:fixture.parity.room_command_receipt);
  });transport.restore('fixture-token');
  const state=await transport.roomReadState('room-id');assert.equal(state.root_position,'9007199254740993');
  await transport.markRoomRead('room-id',fixture.parity.mark_read);
  await transport.setRoomFavorite('room-id',{operation_id:'favorite-original',expected_revision:state.revision,present:false});
  assert.deepEqual(calls.map(({path,method})=>({path,method})),[{path:'/api/v1/rooms/room-id/read',method:'GET'},{path:'/api/v1/rooms/room-id/read',method:'POST'},{path:'/api/v1/rooms/room-id/favorite',method:'PUT'}]);
  assert.deepEqual(calls[1].body,{root_position:'9007199254740993',reply_position:'9007199254740994'});
  assert.deepEqual(calls[2].body,{operation_id:'favorite-original',expected_revision:state.revision,present:false});
});
test('read cooldowns preserve independent mutations, while favorite cooldowns share room commands',async()=>{
  let mutations=0;
  const transport=new NativeTransport('http://localhost:3400',async(url,options)=>{
    const path=new URL(String(url)).pathname,method=options?.method??'GET';
    if(method!=='GET'){mutations++;return Response.json({code:path.endsWith('/read')?'room_read_limit':'room_command_limit',request_id:'synthetic-quota'},{status:429,headers:{'Retry-After':'60'}});}
    return Response.json(path.endsWith('/read')?fixture.parity.read_state:fixture.parity.room_command_receipt);
  });transport.restore('fixture-token');
  const quota=(error:unknown)=>error instanceof NativeError && error.status===429;
  await assert.rejects(transport.markRoomRead('room-id',{root_position:'1',reply_position:'0'}),quota);
  await assert.rejects(transport.markRoomRead('room-id',{root_position:'1',reply_position:'0'}),quota);
  assert.equal(mutations,1);await transport.roomReadState('room-id');
  await assert.rejects(transport.setRoomFavorite('room-id',{operation_id:'favorite',expected_revision:'1',present:true}),quota);assert.equal(mutations,2);
  await assert.rejects(transport.leaveRoom('room-id',{operation_id:'leave',expected_revision:'opaque-revision'}),quota);assert.equal(mutations,2);
  await transport.roomCommandReceipt('room-id','favorite');
});
