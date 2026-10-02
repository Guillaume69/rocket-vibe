import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import type {Room,Snapshot,SyncBatch} from './protocol.generated.ts';
const session:Session={baseUrl:'http://localhost:3400',authToken:'token',userId:'alice',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
function room(revision='20',personal='9007199254740993',membership='same'):Room {
  return {id:'room',name:`Room ${revision}`,kind:'private',revision,read_state:{room_id:'room',revision:personal,membership_version:membership,favorite_revision:personal,root_position:'0',reply_position:'0',unread_roots:'1',unread_replies:'0',mentions:'1',group_mentions:'0',favorite:true}};
}
function snapshot(value=room()):Snapshot{return {protocol_version:1,rooms:[value],messages:[],cursor:'initial'};}
function batch(value:Room):SyncBatch{return {protocol_version:1,changes:[{type:'room_upsert',data:value}],cursor:'next',has_more:false};}
function setup(){const harness=nativeTestDatabase();return {...harness,store:new NativeStore(harness.adapter,creerFileEcritures(),session)};}

test('personal and room versions merge independently beyond JS precision',async()=>{
  const {db,store}=setup();try {
    await store.applySnapshot(snapshot());
    const newer=room('10','9007199254740994');newer.read_state!.favorite=false;
    await store.applyBatch(batch(newer));assert.equal((await store.rooms())[0].nom,'Room 20');assert.equal((await store.readState('room'))?.favorite,false);
    await store.applyBatch(batch(room('21')));assert.equal((await store.rooms())[0].nom,'Room 21');assert.equal((await store.readState('room'))?.revision,'9007199254740994');
    assert.equal((await store.readState('room'))?.favorite,false);
  } finally {db.close();}
});
test('missed withdrawal and rejoin purge old sends and drafts and fence late reads',async()=>{
  const {db,store}=setup();try {
    await store.applySnapshot(snapshot(room('1','2','before')));await store.enqueue('unsent','room','Old private send');await store.drafts().ecrire('room','Private draft');
    const token=store.projectionToken(),old=(await store.readState('room'))!;
    await store.applyBatch(batch(room('4','5','after')));
    assert.ok(store.projectionToken()>token);assert.deepEqual(await store.pending(),[]);assert.equal(await store.drafts().lire('room'),null);assert.deepEqual(await store.messages('room'),[]);
    assert.equal(await store.cacheReadState(old,token),false);
    assert.equal(await store.cacheReadState({...old,revision:'99'},store.projectionToken()),false);
    await store.applyBatch(batch(room('1','2','before')));assert.equal((await store.readState('room'))?.membership_version,'after');
  } finally {db.close();}
});
test('metadata and roles keep the same membership and unsent intentions',async()=>{
  const {db,store}=setup();try {
    await store.applySnapshot(snapshot(room('1','2')));await store.enqueue('unsent','room','Keep send');await store.drafts().ecrire('room','Keep draft');
    const token=store.projectionToken();await store.applyBatch(batch(room('3','2')));
    assert.equal(store.projectionToken(),token);assert.equal((await store.pending()).length,1);assert.equal(await store.drafts().lire('room'),'Keep draft');
  } finally {db.close();}
});
test('read state survives a real SQLite reopen and is hidden on a new epoch',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-read-cache-')),filename=join(directory,'account.sqlite');
  const original=nativeTestDatabase(filename);let reopened:ReturnType<typeof nativeTestDatabase>|undefined;
  try {
    const store=new NativeStore(original.adapter,creerFileEcritures(),session);await store.applySnapshot(snapshot());original.db.close();
    reopened=nativeTestDatabase(filename,false);const resumed=new NativeStore(reopened.adapter,creerFileEcritures(),session);assert.equal((await resumed.readState('room'))?.favorite,true);
    const restored=new NativeStore(reopened.adapter,creerFileEcritures(),{...session,nativeDataEpoch:'new-epoch'});assert.equal(await restored.readState('room'),null);
    await restored.prepare();assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM native_read_states').get()?.n,0);
  } finally {reopened?.db.close();if(!reopened){try{original.db.close();}catch{}}unlinkSync(filename);rmdirSync(directory);}
});
test('invalid state and failed commits roll back lifetime purge and cursor together',async()=>{
  const {db,store,failWhen}=setup();try {
    await store.applySnapshot(snapshot(room('1','2')));await store.enqueue('unsent','room','Keep on failure');const token=store.projectionToken();
    const invalid=room('3','4');invalid.read_state!.room_id='another';await assert.rejects(store.applyBatch(batch(invalid)));
    failWhen(sql=>sql.startsWith('INSERT INTO native_sync_state'));await assert.rejects(store.applyBatch(batch(room('3','4','other'))));failWhen(null);
    assert.equal(store.projectionToken(),token);assert.equal((await store.pending()).length,1);assert.equal((await store.state())?.cursor,'initial');assert.equal((await store.readState('room'))?.membership_version,'same');
    const malformed=room('3','4');malformed.read_state!.root_position='01';await assert.rejects(store.applyBatch(batch(malformed)));
  } finally {db.close();}
});
test('first stamped snapshot cannot replay intentions from an unstamped legacy cache',async()=>{
  const {db,store}=setup();try {
    const old=room('1','2');delete old.read_state;await store.applySnapshot(snapshot(old));await store.enqueue('legacy-unsent','room','Unstamped send');
    await store.applySnapshot(snapshot(room('1','2')));assert.deepEqual(await store.pending(),[]);
  } finally {db.close();}
});
test('late HTTP state cannot rewind reads or favorites in the same lifetime',async()=>{
  const {db,store}=setup();try {
    await store.applySnapshot(snapshot(room('1','2')));const old=(await store.readState('room'))!;
    assert.equal(await store.cacheReadState({...old,revision:'3',root_position:'1'},store.projectionToken()),true);
    assert.equal(await store.cacheReadState(old,store.projectionToken()),false);
    await assert.rejects(store.cacheReadState({...old,revision:'4'},store.projectionToken()));
    await assert.rejects(store.cacheReadState({...old,revision:'4',root_position:'1',favorite_revision:'1'},store.projectionToken()));
    assert.equal((await store.readState('room'))?.revision,'3');
  } finally {db.close();}
});
test('repeated HTTP reads do not write SQLite or invalidate effective rights',async()=>{
  const {db,store}=setup();try {
    await store.applySnapshot(snapshot());
    db.prepare("UPDATE native_room_access SET read_only=1,can_send=1,role='owner' WHERE rid='room'").run();
    const old=(await store.readState('room'))!,before=db.prepare('SELECT total_changes() AS n').get()?.n;
    assert.equal(await store.cacheReadState(old,store.projectionToken()),true);
    assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n,before);
    const newer=room('20','9007199254740994');await store.applyBatch(batch(newer));
    const access=await store.roomAccess('room');assert.equal(access?.can_send,1);assert.equal(access?.role,'owner');
  } finally {db.close();}
});
