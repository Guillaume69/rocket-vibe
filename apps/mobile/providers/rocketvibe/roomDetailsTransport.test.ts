import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';
import type { NativeTypes } from './protocol.generated.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8')).parity;
const update:NativeTypes['UpdateRoom'] = fixture.update_room;
const role:NativeTypes['ChangeRoomRole'] = fixture.change_room_role;
const leave:NativeTypes['LeaveRoom'] = fixture.leave_room;

test('room operations use typed authenticated routes and original operation bodies', async()=>{
  const sent:{url:string;verb:string|undefined;body:string|undefined}[]=[];
  const client = new NativeTransport('https://example.org/chat', async (url, options)=>{
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer saved-token');
    assert.equal(options?.redirect,'error');
    const path=new URL(String(url)).pathname;
    sent.push({url:String(url),verb:options?.method,body:options?.body as string|undefined});
    return Response.json(options?.method==='GET' && path.endsWith('/members') ? fixture.room_members : options?.method==='GET' && path.endsWith('/room-id') ? fixture.room_details : fixture.room_command_receipt);
  });
  client.restore('saved-token');
  assert.equal((await client.roomDetails('room-id')).room.revision,'9007199254740993');
  await client.roomMembers('room-id','alice-id','details-version');
  await client.updateRoom('room-id',update);
  await client.changeRoomRole('room-id','alice-id',role);
  await client.leaveRoom('room-id',leave);
  await client.roomCommandReceipt('room-id','settings-id');
  assert.deepEqual(sent.map(r=>[r.verb,r.url.replace('https://example.org/chat','')]),[
    ['GET','/api/v1/rooms/room-id'],['GET','/api/v1/rooms/room-id/members?after=alice-id&revision=details-version'],
    ['PATCH','/api/v1/rooms/room-id'],['PUT','/api/v1/rooms/room-id/members/alice-id/role'],
    ['POST','/api/v1/rooms/room-id/leave'],['GET','/api/v1/rooms/room-id/commands/settings-id'],
  ]);
  assert.deepEqual(sent.slice(2,5).map(r=>JSON.parse(r.body!)),[update,role,leave]);
});

test('room command cooldown preserves member reads and receipt recovery',async t=>{
  t.mock.timers.enable({apis:['Date']});
  let mutations=0;
  const client = new NativeTransport('https://example.org',async(url,options)=>{
    if(options?.method!=='GET') { mutations++;return Response.json({code:'room_command_limit',request_id:'room-limit'},{status:429,headers:{'retry-after':'30'}}); }
    const path=new URL(String(url)).pathname;
    return Response.json(path.endsWith('/members')?fixture.room_members:path.includes('/commands/')?fixture.room_command_receipt:fixture.room_details);
  });
  client.restore('saved-token');
  const limited=(error:unknown)=>error instanceof NativeError && error.status===429 && error.requestId==='room-limit';
  await assert.rejects(client.updateRoom('room-id',update),limited);
  await assert.rejects(client.changeRoomRole('room-id','alice-id',role),limited);
  await assert.rejects(client.leaveRoom('room-id',leave),limited);
  await client.roomDetails('room-id');await client.roomMembers('room-id');await client.roomCommandReceipt('room-id','settings-id');
  assert.equal(mutations,1);
  t.mock.timers.tick(30_000);await assert.rejects(client.leaveRoom('room-id',leave),limited);assert.equal(mutations,2);
});

test('room commands reject unknown authority and roster structures remain typed',()=>{
  for(const [name,input] of [['UpdateRoom',update],['ChangeRoomRole',role],['LeaveRoom',leave]] as const) {
    assert.throws(()=>decodeNative(name,{...input,actor_id:'forged'}));
    assert.throws(()=>decodeNative(name,{...input,permissions:{change_settings:true}}));
  }
  assert.throws(()=>decodeNative('ChangeRoomRole',{...role,role:'admin'}));
  assert.throws(()=>decodeNative('RoomMemberPage',{...fixture.room_members,members:[{...fixture.room_members.members[0],disabled:'false'}]}));
});
