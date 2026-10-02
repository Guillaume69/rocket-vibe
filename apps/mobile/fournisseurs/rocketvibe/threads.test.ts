import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import {NativeStore,localMessage} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import type {Message,Room,ThreadPage} from './protocol.generated.ts';
const session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice',username:'alice',genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:'threads-instance',nativeDataEpoch:'epoch'};
function room(grant='grant'):Room{return {id:'room',name:'Room',kind:'private',revision:'1',read_state:{room_id:'room',membership_version:grant,favorite_revision:'1',revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}};}
function message(id:string,position:string,reply_to?:string):Message{return {id,room_id:'room',author:{id:'bob',username:'bob',display_name:'Bob'},text:id,created_at:'2026-10-03T08:00:00Z',position,revision:position,...(reply_to?{reply_to}:{})};}
function page():ThreadPage{return {root:{...message('root','1'),revision:'9007199254740995',thread:{replies:'2',last_reply_at:'2026-10-03T08:00:00Z'}},messages:[message('second','9007199254740994','root'),message('first','9007199254740993','root')],has_more:false,read_state:{root_id:'root',room_id:'room',membership_version:'grant',position:'0',revision:'9007199254740995',unread:'2'}};}

test('thread outbox, independent drafts and exact observed reads survive reset and disk restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-threads-')),filename=join(directory,'cache.sqlite');
  let h=nativeTestDatabase(filename),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot({protocol_version:1,rooms:[room()],messages:[],cursor:'initial'});
    const thread=page();assert.equal(await store.cacheThread(thread,store.projectionToken()),true);
    assert.equal(localMessage(thread.root).filReponses,2);assert.equal(localMessage(thread.messages[0]).filId,'root');
    const drafts=store.drafts({room:'room',membership:'grant'});
    await drafts.ecrire('room','Room draft');await drafts.ecrire('room:root','Thread draft');
    assert.equal(await drafts.lire('room'),'Room draft');assert.equal(await drafts.lire('room:root'),'Thread draft');
    await store.enqueue('queued','room','Offline reply',{membership:'grant'},[],'root');
    assert.equal((await store.pending())[0].reply_to,'root');
    assert.equal(await store.stageThreadRead('root','root','grant'),false);
    assert.equal(await store.stageThreadRead('other-thread','second','grant'),false);
    assert.equal(await store.stageThreadRead('root','first','grant'),true);
    assert.equal(await store.stageThreadRead('root','second','grant'),true);
    await store.completeThreadRead({...thread.read_state,position:'9007199254740993',unread:'1'},store.projectionToken());
    assert.equal((await store.pendingThreadReads())[0].position,'9007199254740994','an older receipt cannot erase a newer observation');
    await store.applySnapshot({protocol_version:1,rooms:[room()],messages:[thread.root],cursor:'reset'});
    assert.equal((await store.pending())[0].reply_to,'root');assert.equal((await store.pendingThreadReads())[0].position,'9007199254740994');
    assert.equal(h.db.prepare("SELECT fil_id FROM messages WHERE id='queued'").get()!.fil_id,'root');
    h.db.close();h=nativeTestDatabase(filename,false);store=new NativeStore(h.adapter,creerFileEcritures(),session);
    assert.equal((await store.pending())[0].reply_to,'root');assert.equal(await store.drafts().lire('room:root'),'Thread draft');
    assert.equal((await store.pendingThreadReads())[0].position,'9007199254740994');
    await store.completeThreadRead({...thread.read_state,position:'9007199254740994',revision:'9007199254740996',unread:'0'},store.projectionToken());
    assert.equal((await store.pendingThreadReads()).length,0);
  }finally{h.db.close();unlinkSync(filename);rmdirSync(directory);}
});

test('thread projection rolls back malformed pages and fences old grants and callbacks',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  try{
    await store.applySnapshot({protocol_version:1,rooms:[room()],messages:[],cursor:'initial'});
    const thread=page(),token=store.projectionToken();
    await assert.rejects(store.cacheThread({...thread,messages:[{...thread.messages[0],room_id:'other'}]},token),/thread page/);
    h.failWhen(sql=>sql.startsWith('INSERT INTO native_positions'));
    await assert.rejects(store.cacheThread(thread,token),/Injected/);h.failWhen(null);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM native_thread_states').get()!.n,0);
    assert.equal((await store.state())?.cursor,'initial');
    await store.cacheThread(thread,token);await store.stageThreadRead('root','second','grant');
    await store.enqueue('optimistic-root','room','Awaiting confirmation',{membership:'grant'});
    await assert.rejects(store.enqueue('invalid-child','room','Not a confirmed thread',{membership:'grant'},[],'optimistic-root'),/root unavailable/);
    assert.equal((await store.pending()).some(row=>row.id==='invalid-child'),false);
    const drafts=store.drafts({room:'room',membership:'grant'});await drafts.ecrire('room:root','Private words');
    await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:'room'}}],cursor:'removed',has_more:false});
    assert.equal((await store.pendingThreadReads()).length,0);assert.equal(await store.drafts().lire('room:root'),null);
    await store.applySnapshot({protocol_version:1,rooms:[room('new-grant')],messages:[thread.root],cursor:'joined'});
    await drafts.ecrire('room:root','Late old write');assert.equal(await store.drafts().lire('room:root'),null);
    assert.equal(await store.stageThreadRead('root','second','grant'),false);
    assert.equal(await store.cacheThread(thread,token),false);
  }finally{h.db.close();}
});
