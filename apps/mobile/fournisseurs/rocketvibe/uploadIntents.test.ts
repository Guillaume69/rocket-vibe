import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeStore,localMessage} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Room,Message,Upload} from './protocol.generated.ts';
import type {UploadIntent} from './uploadIntents.ts';
const session={baseUrl:'https://native.example',authToken:'token',userId:'alice',username:'alice',genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
const room=(membership='grant'):Room=>({id:'room',name:'Room',kind:'private',revision:'1',read_state:{room_id:'room',membership_version:membership,revision:membership==='grant'?'1':'2',favorite_revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}});
const snapshot=(membership='grant')=>({protocol_version:1,rooms:[room(membership)],messages:[],cursor:'initial'});
const intent:UploadIntent={id:'prepare',room:'room',membership:'grant',uri:'file:///private/original',prepare:{operation_id:'prepare',room_id:'room',bytes:'3',sha256:'a'.repeat(64),filename:'original.pdf',media_type:'application/pdf',encrypted:false},complete:{operation_id:'confirm',content:{kind:'plain',markdown:'Caption',mentions:[],quotes:[],files:[]}}};
const upload:Upload={id:'file',state:'ready',expires_at:'2026-10-04T00:00:00Z',message_id:null,file:{id:'file',room_id:'room',bytes:'3',sha256:'a'.repeat(64),filename:'original.pdf',media_type:'application/pdf',encrypted:false}};
const message:Message={id:'confirm',room_id:'room',author:{id:'alice',username:'alice',display_name:'Alice'},text:'Caption',created_at:'2026-10-03T00:00:00Z',position:'1',revision:'1',files:[upload.file]};
test('file intentions survive disk restart with original bytes, membership, caption and operation IDs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rv-files-')),path=join(root,'cache.sqlite');let h=nativeTestDatabase(path),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot(snapshot());await store.uploads.stage(intent);await store.uploads.claim(intent);await store.uploads.remember(intent,upload);
    h.db.close();h=nativeTestDatabase(path,false);store=new NativeStore(h.adapter,creerFileEcritures(),session);
    await store.uploads.reset([]);assert.deepEqual(await store.uploads.get('prepare'),{...intent,phase:'pending',status:'en-attente',fileId:'file'});
    await store.uploads.cancelling(intent);assert.equal((await store.uploads.get('prepare'))?.phase,'cancelling');
    await store.applySnapshot(snapshot());assert.equal((await store.uploads.get('prepare'))?.phase,'cancelling');
    assert.equal(await store.uploads.confirm(intent,message,()=>true),true);assert.equal(await store.uploads.get('prepare'),null);
    assert.equal((await store.fileAccess('file'))?.file.sha256,upload.file.sha256);
    await store.applyBatch({protocol_version:1,cursor:'deleted',has_more:false,changes:[{type:'message_upsert',data:{...message,revision:'2',text:'',deleted:true,files:[]}}]});
    assert.equal(await store.fileAccess('file'),null);
  }finally{h.db.close();unlinkSync(path);rmdirSync(root);}
});
test('file and UI rows roll back together; mismatched receipts cannot clear an intention',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot(snapshot());h.failWhen(sql=>sql.includes('INSERT INTO televersements'));
    await assert.rejects(store.uploads.stage(intent));assert.equal(h.db.prepare('SELECT count(*) AS n FROM native_upload_intents').get()!.n,0);
    h.failWhen(null);await store.uploads.stage(intent);await store.uploads.remember(intent,upload);
    await assert.rejects(store.uploads.remember(intent,{...upload,file:{...upload.file,sha256:'b'.repeat(64)}}),/invalid_upload/);
    await assert.rejects(store.uploads.confirm(intent,{...message,id:'wrong'},()=>true),/invalid_upload_receipt/);
    let checks=0;await assert.rejects(store.uploads.confirm(intent,message,()=>++checks===1),/session_closed/);
    assert(await store.uploads.get('prepare'));assert.equal(await store.fileAccess('file'),null);
  }finally{h.db.close();}
});
test('withdrawal, rejoin and a different epoch cannot revive or complete an old file',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot(snapshot());await store.uploads.stage(intent);
    await store.applySnapshot(snapshot('replacement'));assert.deepEqual(await store.uploads.list(),[]);
    assert.equal(await store.uploads.confirm(intent,message,()=>true),false);
    await assert.rejects(store.uploads.stage(intent),/upload_scope_changed/);
    const fresh={...intent,id:'new',membership:'replacement',prepare:{...intent.prepare,operation_id:'new'}};await store.uploads.stage(fresh);
    const replacement=new NativeStore(h.adapter,creerFileEcritures(),{...session,nativeDataEpoch:'new-epoch'});await replacement.prepare();
    assert.equal((await replacement.uploads.list()).length,0);assert.equal(await store.uploads.discard(fresh),false);
  }finally{h.db.close();}
});
test('native manifests preserve the existing attachment presentation and refuse remote paths and hostile metadata',()=>{
  const attachment=JSON.parse(localMessage(message).piecesJointes!)[0];assert.equal(attachment.title,'original.pdf');assert.equal(attachment.title_link,'/api/v1/files/file');
  for(const bad of [{id:'https://other.invalid/file'},{room_id:'other'},{filename:'../secret'},{media_type:'text/html'},{sha256:'bad'},{bytes:'104857601'},{encrypted:true}])assert.throws(()=>localMessage({...message,files:[{...upload.file,...bad}]}),/invalid_file/);
});

test('files from search stay temporary and expire with their original room grant',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot(snapshot());await store.cacheFileViews([message],'room','grant',()=>true);
    assert.equal((await store.fileAccess('file'))?.file.id,'file');assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages').get()!.n,0);
    await store.applySnapshot(snapshot('replacement'));assert.equal(await store.fileAccess('file'),null);
    await assert.rejects(store.cacheFileViews([message],'room','grant',()=>true),/file_scope_closed/);
  }finally{h.db.close();}
});
