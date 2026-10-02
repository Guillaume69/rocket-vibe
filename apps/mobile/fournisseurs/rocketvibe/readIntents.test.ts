import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import type {Snapshot,Message,RoomCommandReceipt} from './protocol.generated.ts';
import type {SavedFavorite} from './readIntents.ts';
const session:Session={baseUrl:'http://localhost:3400',authToken:'token',userId:'alice',username:'alice',genre:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
function snapshot(membership='membership'):Snapshot {
  const message:Message={...fixture.message,id:'observed',room_id:'room',position:'9007199254740993'};
  return {protocol_version:1,cursor:'initial',rooms:[{id:'room',name:'Room',kind:'private',revision:'1',read_state:{room_id:'room',revision:'10',membership_version:membership,favorite_revision:'9',root_position:'0',reply_position:'0',unread_roots:'2',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}}],messages:[message,{...message,id:'newest',position:'9007199254740994',revision:'11'}]};
}
async function setup(){const harness=nativeTestDatabase();const store=new NativeStore(harness.adapter,creerFileEcritures(),session);await store.applySnapshot(snapshot());return {...harness,store};}
async function state(store:NativeStore,revision:string,root='0',favoriteVersion='9',favorite=false){
  const old=(await store.readState('room'))!;
  assert.equal(await store.cacheReadState({...old,revision,root_position:root,favorite_revision:favoriteVersion,favorite},store.projectionToken()),true);
}
function receipt(saved:SavedFavorite,applied_revision='12'):RoomCommandReceipt{return {operation_id:saved.input.operation_id,room_id:saved.room,applied_revision};}

test('only observed confirmed IDs advance; newer observed reads survive an older HTTP ack',async()=>{
  const {store,db}=await setup();try{
    await store.enqueue('unsent','room','Local only');assert.equal(await store.stageRead('room','unsent'),false);
    assert.equal(await store.stageRead('room','observed'),true);assert.equal((await store.pendingReads())[0].root_position,'9007199254740993');
    assert.equal(await store.stageRead('room','observed'),false);assert.equal(await store.stageRead('room','newest'),true);
    assert.equal(await store.stageRead('room','observed'),false);assert.equal((await store.pendingReads())[0].root_position,'9007199254740994');
    await state(store,'12','9007199254740993');assert.equal((await store.pendingReads()).length,1);
    await state(store,'13','9007199254740994');assert.deepEqual(await store.pendingReads(),[]);assert.equal(await store.stageRead('room','observed'),false);
  }finally{db.close();}
});
test('real SQLite reopen retains original read, favorite nonce and CAS despite newer cache',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-read-intents-')),filename=join(directory,'account.sqlite');
  const original=nativeTestDatabase(filename);let resumed:ReturnType<typeof nativeTestDatabase>|undefined;
  try{
    const store=new NativeStore(original.adapter,creerFileEcritures(),session);await store.applySnapshot(snapshot());await store.stageRead('room','observed');
    const saved=(await store.stageFavorite('room',true,()=> 'favorite-original'))!;original.db.close();
    resumed=nativeTestDatabase(filename,false);const reopened=new NativeStore(resumed.adapter,creerFileEcritures(),session);
    await state(reopened,'20','0','19');const retry=(await reopened.stageFavorite('room',true,()=> 'must-not-generate'))!;
    assert.deepEqual(retry.input,saved.input);assert.equal((await reopened.pendingReads())[0].root_position,'9007199254740993');
    assert.equal(await reopened.stageFavorite('room',false,()=> 'must-not-replace'),null);
    const other=new NativeStore(resumed.adapter,creerFileEcritures(),{...session,nativeDataEpoch:'restored'});
    assert.deepEqual(await other.pendingReads(),[]);assert.deepEqual(await other.pendingFavorites(),[]);await other.prepare();
    assert.equal(resumed.db.prepare('SELECT count(*) AS n FROM native_favorite_intents').get()?.n,0);
  }finally{resumed?.db.close();if(!resumed){try{original.db.close();}catch{}}unlinkSync(filename);rmdirSync(directory);}
});
test('favorite receipt is a floor and never projects the historical boolean',async()=>{
  const {store,db}=await setup();try{
    const saved=(await store.stageFavorite('room',true,()=> 'favorite'))!;
    assert.equal(await store.confirmFavoriteReceipt(receipt(saved),store.projectionToken()),true);
    assert.equal((await store.readState('room'))?.favorite,false);assert.equal((await store.pendingFavorites())[0].phase,'confirmed');
    await state(store,'13','0','11');assert.equal((await store.pendingFavorites()).length,1);
    await state(store,'14','0','14',false);assert.deepEqual(await store.pendingFavorites(),[]);assert.equal((await store.readState('room'))?.favorite,false);
    assert.equal(await store.confirmFavoriteReceipt(receipt(saved),store.projectionToken()),false);
  }finally{db.close();}
});
test('failed favorite requires exact dismissal and cannot overwrite ambiguous commands',async()=>{
  const {store,db}=await setup();try{
    const saved=(await store.stageFavorite('room',true,()=> 'original'))!;
    assert.equal(await store.dismissFailedFavorite('room',saved.input.operation_id),false);
    await store.failFavorite('room','original','revision_conflict');assert.equal(await store.stageFavorite('room',true,()=> 'blocked'),null);
    assert.equal(await store.dismissFailedFavorite('room','wrong'),false);assert.equal(await store.dismissFailedFavorite('room','original'),true);
    assert.equal((await store.stageFavorite('room',false,()=> 'replacement'))?.input.operation_id,'replacement');
    assert.equal(await store.dismissFailedFavorite('room','original'),false);
  }finally{db.close();}
});
test('same membership snapshot preserves intentions; missed rejoin purges and fences stale receipts',async()=>{
  const {store,db}=await setup();try{
    await store.stageRead('room','observed');const saved=(await store.stageFavorite('room',true,()=> 'original'))!;
    await store.applySnapshot(snapshot());assert.equal((await store.pendingReads()).length,1);assert.equal((await store.favoriteIntent('room'))?.input.operation_id,'original');
    const token=store.projectionToken(),next=snapshot('rejoined');next.rooms[0].read_state!.revision='20';await store.applySnapshot(next);
    assert.deepEqual(await store.pendingReads(),[]);assert.deepEqual(await store.pendingFavorites(),[]);
    await store.stageFavorite('room',false,()=> 'replacement');assert.equal(await store.confirmFavoriteReceipt(receipt(saved),token),false);
    assert.equal((await store.favoriteIntent('room'))?.input.operation_id,'replacement');
    await store.applyBatch({protocol_version:1,cursor:'removed',has_more:false,changes:[{type:'room_removed',data:{room_id:'room'}}]});
    assert.deepEqual(await store.pendingFavorites(),[]);
  }finally{db.close();}
});
test('invalid receipts and corrupt floors roll back without losing the original intent',async()=>{
  const {store,db}=await setup();try{
    const saved=(await store.stageFavorite('room',true,()=> 'original'))!;
    await assert.rejects(store.confirmFavoriteReceipt(receipt(saved,'8'),store.projectionToken()));
    assert.throws(()=>store.confirmFavoriteReceipt(receipt(saved,'012'),store.projectionToken()));assert.equal((await store.favoriteIntent('room'))?.phase,'pending');
    db.prepare("UPDATE native_favorite_intents SET phase='confirmed',receipt_revision='bogus'").run();
    await assert.rejects(store.pendingFavorites());await assert.rejects(state(store,'20'));assert.equal((await store.readState('room'))?.revision,'10');
  }finally{db.close();}
});
test('rendered favorite guards its observed revision and membership and projects only confirmed preferences',async()=>{
  const {store,db}=await setup();try{
    await state(store,'20','0','19');
    assert.equal(await store.stageFavorite('room',true,()=>{throw new Error('Stale click created an ID');},{membership:'membership',revision:'9'}),null);
    assert.equal(await store.stageFavorite('room',true,()=>{throw new Error('Old membership created an ID');},{membership:'obsolete',revision:'19'}),null);
    const saved=(await store.stageFavorite('room',true,()=> 'ui-favorite',{membership:'membership',revision:'19'}))!;
    assert.equal(saved.input.expected_revision,'19');
    assert.equal(db.prepare('SELECT favori FROM abonnements WHERE rid=?').get('room')?.favori,0);
    await state(store,'21','0','21',true);
    assert.equal(db.prepare('SELECT favori FROM abonnements WHERE rid=?').get('room')?.favori,1);
    const oldMetadata=snapshot().rooms[0];
    await store.applyBatch({protocol_version:1,cursor:'old-metadata',has_more:false,changes:[{type:'room_upsert',data:{...oldMetadata,revision:'0',read_state:{...(await store.readState('room'))!,revision:'22',favorite_revision:'22',favorite:false}}}]});
    assert.equal(db.prepare('SELECT favori FROM abonnements WHERE rid=?').get('room')?.favori,0);
    assert.equal((await store.favoriteIntent('room'))?.input.operation_id,'ui-favorite');
  }finally{db.close();}
});
test('queue writes and membership cleanup commit atomically when SQLite fails',async()=>{
  const {store,db,failWhen}=await setup();try{
    await store.stageRead('room','observed');await store.stageFavorite('room',true,()=> 'original');const token=store.projectionToken();
    const next=snapshot('rejoined');next.rooms[0].read_state!.revision='20';failWhen(sql=>sql.startsWith('INSERT INTO native_sync_state'));
    await assert.rejects(store.applySnapshot(next));failWhen(null);assert.equal(store.projectionToken(),token);
    assert.equal((await store.pendingReads()).length,1);assert.equal((await store.favoriteIntent('room'))?.input.operation_id,'original');
    failWhen(sql=>sql.startsWith('UPDATE native_favorite_intents'));await assert.rejects(store.confirmFavoriteReceipt(receipt((await store.favoriteIntent('room'))!),token));failWhen(null);
    assert.equal((await store.favoriteIntent('room'))?.phase,'pending');
  }finally{db.close();}
});
