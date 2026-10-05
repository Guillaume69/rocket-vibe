import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmdirSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {Session} from '../../lib/auth.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {avatarBase64} from '../../lib/nativeAvatars.ts';
import {avatarBytes,nativeMyProfile,profileIntent,profileOperation,type ProfileOperation} from './profileOperations.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
const snapshot={protocol_version:1,rooms:[],messages:[],cursor:'initial'};
const profile=(id='original',revision='original-revision'):ProfileOperation=>({kind:'profile',input:{operation_id:id,expected_revision:revision,username:'alice',display_name:'Alice',bio:'Desired bio',status:'busy',status_text:'Working'}});
function setup(){const harness=nativeTestDatabase();return {...harness,store:new NativeStore(harness.adapter,createWriteQueue(),session)};}

test('profile recovery retains the original nonce, revision and form across a disk reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-profile-command-')),path=join(directory,'account.sqlite');
  let harness=nativeTestDatabase(path);
  try{
    let store=new NativeStore(harness.adapter,createWriteQueue(),session);await store.applySnapshot(snapshot);
    const saved=(await store.profileOperations.stage(profile()))!;harness.db.close();
    harness=nativeTestDatabase(path,false);store=new NativeStore(harness.adapter,createWriteQueue(),session);
    assert.deepEqual(await store.profileOperations.stage(profile('replacement','newer')),saved);
    const different=profile('other','fresh');if(different.kind==='profile')different.input.bio='Other bio';
    assert.equal(await store.profileOperations.stage(different),null);
    assert.equal(await store.profileOperations.discard('profile','original'),false);
    await assert.rejects(async()=>store.profileOperations.confirm(saved,{operation_id:'wrong',applied_revision:'applied'},()=>true));
    assert.deepEqual(await store.profileOperations.get('profile'),saved);
    await store.profileOperations.confirm(saved,{operation_id:'original',applied_revision:'applied'},()=>true);
    assert.equal(await store.profileOperations.get('profile'),null);
  }finally{harness.db.close();unlinkSync(path);rmdirSync(directory);}
});
test('proof and rejected forms remain recoverable; an obsolete acknowledgement cannot clear a new attempt',async()=>{
  const {db,store}=setup();
  try{
    await store.applySnapshot(snapshot);const saved=(await store.profileOperations.stage(profile()))!;
    await store.profileOperations.mark(saved,'proof','reauthentication_required');
    assert.deepEqual(await store.profileOperations.pending(),[]);
    assert.equal((await store.profileOperations.stage(profile('replacement','fresh')))?.phase,'proof');
    const desired=profileIntent(await store.profileOperations.get('profile'),nativeMyProfile(fixture.own_profile));
    assert.equal(desired.bio,'Desired bio');assert.equal(desired.email,fixture.own_profile.email??'');
    assert.equal(await store.profileOperations.discard('profile','wrong'),false);
    assert.equal(await store.profileOperations.discard('profile','original'),true);
    const next=(await store.profileOperations.stage(profile('next','fresh')))!;
    await store.profileOperations.confirm(saved,{operation_id:'original',applied_revision:'applied'},()=>true);
    assert.deepEqual(await store.profileOperations.get('profile'),next);
    await store.profileOperations.mark(next,'failed','profile_conflict');
    assert.equal(await store.profileOperations.stage(profile('third','freshest')),null);
    assert.equal(profileIntent(await store.profileOperations.get('profile'),desired).bio,'Desired bio');
  }finally{db.close();}
});
test('normal resets retain account intentions; changing authority hides and purges them',async()=>{
  const {db,adapter,store}=setup();
  try{
    await store.applySnapshot(snapshot);await store.profileOperations.stage(profile());
    await store.applySnapshot({...snapshot,cursor:'reset'});
    assert.equal((await store.profileOperations.pending()).length,1);
    const replacement=new NativeStore(adapter,createWriteQueue(),{...session,nativeDataEpoch:'replacement'});
    assert.equal(await replacement.profileOperations.get('profile'),null);
    await replacement.applySnapshot(snapshot);
    assert.equal(db.prepare('SELECT count(*) n FROM native_profile_operations').get()?.n,0);
  }finally{db.close();}
});
test('avatar recovery stores immutable bytes; corrupt payloads are quarantined and confirmation rolls back on closure',async()=>{
  const {db,store}=setup();
  try{
    await store.applySnapshot(snapshot);const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
    const command:ProfileOperation={kind:'avatar',input:{operation_id:'avatar',expected_revision:'rev'},upload:{mime:'image/png',base64:avatarBase64(bytes)}};
    const saved=(await store.profileOperations.stage(command))!;bytes.fill(0);
    assert.equal(saved.command.kind==='avatar'&&avatarBytes(saved.command.upload!.base64)[0],137);
    let checks=0;await assert.rejects(store.profileOperations.confirm(saved,{operation_id:'avatar',applied_revision:'applied'},()=>++checks===1),/session_closed/);
    assert.equal((await store.profileOperations.get('avatar'))?.command.input.operation_id,'avatar');
    db.prepare('UPDATE native_profile_operations SET payload=?').run('{"kind":"avatar","input":{}}');
    assert.deepEqual(await store.profileOperations.pending(),[]);
    assert.equal(db.prepare('SELECT state FROM native_profile_operations').get()?.state,'failed');
    assert.equal(await store.profileOperations.discard('avatar','avatar'),true);
  }finally{db.close();}
});
test('strict profile commands exclude credentials, extra fields and malformed image encodings',()=>{
  assert.throws(()=>profileOperation({...profile(),password:'secret'}));
  const command=profile();assert(command.kind==='profile');
  assert.throws(()=>profileOperation({...command,input:{...command.input,email:'private@example.test'}}));
  assert.throws(()=>profileOperation({...command,input:{...command.input,display_name:''}}));
  assert.throws(()=>avatarBytes('a==='));assert.throws(()=>avatarBytes('AB=='));
  assert.throws(()=>avatarBytes(avatarBase64(new Uint8Array(2*1024*1024+1))));
});
