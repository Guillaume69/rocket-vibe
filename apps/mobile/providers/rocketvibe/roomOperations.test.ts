import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {Session} from '../../lib/auth.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {roomOperation,type RoomOperation} from './roomOperations.ts';

const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
const snapshot={protocol_version:1,rooms:[{id:'room',name:'Room',kind:'private' as const,revision:'1'}],messages:[],cursor:'initial'};
function settings(id='original',revision='original-revision'):RoomOperation{return {kind:'settings',input:{operation_id:id,expected_revision:revision,name:'  Room  ',private:true,topic:'Private subject',description:'Description',announcement:'',read_only:false}};}
function setup(){const harness=nativeTestDatabase();return {...harness,store:new NativeStore(harness.adapter,createWriteQueue(),session)};}

test('room intention survives disk reopen, fresh live revision and repeated receipt',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-room-command-')),path=join(directory,'account.sqlite');
  let harness=nativeTestDatabase(path);
  try{
    let store=new NativeStore(harness.adapter,createWriteQueue(),session);await store.applySnapshot(snapshot);
    await store.stageRoomOperation('room',settings());harness.db.close();
    harness=nativeTestDatabase(path,false);store=new NativeStore(harness.adapter,createWriteQueue(),session);
    const retry=await store.stageRoomOperation('room',settings('replacement','newer-revision'));
    assert.equal(retry?.command.input.operation_id,'original');assert.equal(retry?.command.input.expected_revision,'original-revision');
    const different=settings('other','fresh');if(different.kind==='settings')different.input.topic='Other subject';
    assert.equal(await store.stageRoomOperation('room',different),null);
    assert.equal(await store.dismissRoomOperation('room','original'),false);
    const receipt={operation_id:'original',room_id:'room',applied_revision:'applied'};
    await assert.rejects(store.confirmRoomOperation({...receipt,room_id:'foreign-room'}));
    assert.equal(await store.confirmRoomOperation(receipt),true);assert.equal(await store.confirmRoomOperation(receipt),false);
    assert.equal(await store.roomOperation('room'),null);
    assert.equal((await store.rooms())[0].name,'Room');
  }finally{harness.db.close();unlinkSync(path);rmdirSync(directory);}
});
test('permanent room failures require exact dismissal; withdrawal and rejoin purge the form',async()=>{
  const {db,store}=setup();
  try{
    await store.applySnapshot(snapshot);await store.stageRoomOperation('room',settings());
    await store.failRoomOperation('room','other','last_room_owner');assert.equal((await store.roomOperation('room'))?.failed,false);
    await store.failRoomOperation('room','original','last_room_owner');assert.equal((await store.roomOperation('room'))?.failed,true);
    assert.equal(await store.stageRoomOperation('room',settings('next','fresh')),null);
    assert.equal(await store.dismissRoomOperation('room','other'),false);assert.equal(await store.dismissRoomOperation('room','original'),true);
    await store.stageRoomOperation('room',{kind:'leave',input:{operation_id:'leave',expected_revision:'fresh'}});
    await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:'room'}}],cursor:'removed',has_more:false});
    assert.deepEqual(await store.pendingRoomOperations(),[]);assert.equal(await store.roomOperation('room'),null);
    await store.applySnapshot(snapshot);assert.equal(await store.roomOperation('room'),null);
  }finally{db.close();}
});
test('SQLite write failure rolls back room intentions and a new epoch hides then purges old forms',async()=>{
  const {db,adapter,store,failWhen}=setup();
  try{
    await store.applySnapshot(snapshot);failWhen(sql=>sql.startsWith('INSERT INTO native_room_operations'));
    await assert.rejects(store.stageRoomOperation('room',settings()));assert.deepEqual(await store.pendingRoomOperations(),[]);
    failWhen(null);await store.stageRoomOperation('room',settings());
    const replacement=new NativeStore(adapter,createWriteQueue(),{...session,nativeDataEpoch:'replacement'});
    assert.equal(await replacement.roomOperation('room'),null);assert.deepEqual(await replacement.pendingRoomOperations(),[]);
    await replacement.applySnapshot(snapshot);
    assert.equal((db.prepare('SELECT count(*) AS n FROM native_room_operations').get() as {n:number}).n,0);
  }finally{db.close();}
});
test('room forms reject unknown fields, malformed revisions and oversized UTF-8 metadata',()=>{
  const normal=settings();
  assert.throws(()=>roomOperation({...normal,actor:'administrator'}));
  assert.throws(()=>roomOperation({kind:'role',target:'../target',input:{operation_id:'op',expected_revision:'rev',role:'owner'}}));
  if(normal.kind!=='settings')throw new Error('fixture');
  assert.throws(()=>roomOperation({...normal,input:{...normal.input,expected_revision:'',can_change:true}}));
  assert.throws(()=>roomOperation({...normal,input:{...normal.input,topic:'🚀'.repeat(257)}}));
  assert.throws(()=>roomOperation({...normal,input:{...normal.input,name:'bad\nname'}}));
});
