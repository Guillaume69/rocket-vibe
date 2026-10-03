import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeNative} from './validation.ts';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import {estJointeCitation} from '../../lib/citation.ts';
import {NativeStore} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import type {Message,Room,Snapshot,SyncBatch} from './protocol.generated.ts';
import type {NativeQuoteAttachment} from './quotes.ts';

const session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'alice-id',username:'alice',genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:'quote-instance',nativeDataEpoch:'epoch'};
function room(id:string,revision='1',grant='source-grant'):Room {
  return {id,name:id,kind:'private',revision,read_state:{room_id:id,revision,membership_version:grant,favorite_revision:revision,root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}};
}
function message(id:string,rid:string,revision:string,text:string):Message {
  return {id,room_id:rid,revision,position:revision,text,author:{id:'alice-id',username:'alice',display_name:'Alice'},created_at:'2026-10-02T08:00:00Z'};
}
function initial():Snapshot {
  const source=message('source','origin','10','*Privé* _texte_ :rocket:');
  const reply=message('reply','destination','20','Ma réponse');
  reply.quotes=[{reference:{room_id:source.room_id,message_id:source.id,revision:source.revision},view_position:'20',source_membership_version:'source-grant',excerpt:{author:source.author,text:source.text,created_at:source.created_at,revision:source.revision,membership_version:'source-grant'}}];
  return {protocol_version:1,rooms:[room('origin'),room('destination','1','destination-grant')],messages:[source,reply],cursor:'initial'};
}
function setup(filename?:string,initialize=true) {
  const harness=nativeTestDatabase(filename,initialize);return {...harness,store:new NativeStore(harness.adapter,creerFileEcritures(),session)};
}
async function cards(h:ReturnType<typeof setup>):Promise<NativeQuoteAttachment[]> {
  const row=await h.adapter.getFirstAsync<{pieces_jointes:string|null}>('SELECT pieces_jointes FROM messages WHERE id=?',['reply']);
  const value:NativeQuoteAttachment[]=JSON.parse(row?.pieces_jointes??'[]');
  assert.ok(value.every(estJointeCitation),'projection must use the existing citation component');return value;
}
async function unavailable(h:ReturnType<typeof setup>) {
  const values=await cards(h);assert.equal(values.length,1);assert.equal(values[0].native_unavailable,true);assert.equal(values[0].text,'');assert.equal(values[0].author_name,undefined);
}
function batch(changes:SyncBatch['changes']):SyncBatch {return {protocol_version:1,changes,cursor:'next',has_more:false};}

test('quoted files work without fabricated source history and disappear with source deletion or grant loss',async()=>{
  for(const mime of ['image/png','audio/ogg','video/mp4','application/pdf']){
    const h=setup();try{
      const snapshot=initial(),source=snapshot.messages.shift()!,reply=snapshot.messages[0];
      const file={id:'quoted-file',room_id:source.room_id,bytes:'42',sha256:'a'.repeat(64),media_type:mime,filename:'Private attachment',encrypted:false};
      reply.quotes![0].excerpt!.files=[file];
      await h.store.applySnapshot(snapshot);
      assert.equal(h.db.prepare("SELECT id FROM messages WHERE id='source'").get(),undefined);
      const attachment=(await cards(h))[0].attachments![0] as Record<string,unknown>;
      assert.deepEqual(attachment.native_file,file);assert.equal(attachment.title,file.filename);
      assert.deepEqual(await h.store.fileAccess(file.id),{file,membership:'source-grant'});
      const malformed=structuredClone(reply);malformed.revision='21';malformed.quotes![0].excerpt!.files![0].room_id='destination';
      await assert.rejects(h.store.ingest([malformed]));
      assert.deepEqual((await h.store.fileAccess(file.id))?.file,file);
      await h.store.ingest([{...source,revision:'30',deleted:true,text:''}]);
      assert.equal((await cards(h))[0].native_unavailable,true);assert.equal(await h.store.fileAccess(file.id),null);
      await h.store.ingest([reply]);assert.equal(await h.store.fileAccess(file.id),null);
    }finally{h.db.close();}
  }
  const h=setup();try{
    const snapshot=initial(),reply=snapshot.messages[1],file={id:'grant-file',room_id:'origin',bytes:'10',sha256:'b'.repeat(64),media_type:'application/pdf',filename:'grant.pdf',encrypted:false};
    snapshot.messages[0].files=[file];reply.quotes![0].excerpt!.files=[file];
    await h.store.applySnapshot(snapshot);
    const unavailable=structuredClone(reply);unavailable.quotes![0].view_position='30';unavailable.quotes![0].excerpt=null;
    await h.store.ingest([unavailable]);assert.equal(await h.store.fileAccess(file.id),null);
    assert.ok(h.db.prepare("SELECT pieces_jointes FROM messages WHERE id='source'").get(),'the old source manifest remains cached but cannot authorize a read');
    await h.store.applyBatch(batch([{type:'room_removed',data:{room_id:'origin'}}]));
    await h.store.ingest([reply]);assert.equal(await h.store.fileAccess(file.id),null);
    assert.equal((await cards(h))[0].attachments,undefined);
    await h.store.applyBatch(batch([{type:'room_upsert',data:room('origin','40','new-grant')} ]));
    await h.store.ingest([reply]);assert.equal(await h.store.fileAccess(file.id),null);
  }finally{h.db.close();}
});

test('nested cards keep independent source grants and never retain descendant text inside their parent',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-nested-quotes-')),filename=join(directory,'cache.sqlite');
  let h=setup(filename);try{
    const snapshot=initial(),parent=snapshot.messages[0],reply=snapshot.messages[1];
    const leaf=message('leaf','leaf-room','25','Nested private leaf');
    leaf.files=[{id:'leaf-file',room_id:leaf.room_id,bytes:'5',sha256:'a'.repeat(64),media_type:'application/pdf',filename:'leaf.pdf',encrypted:false}];
    parent.revision='26';parent.position='26';reply.revision='30';reply.position='30';
    const child={reference:{room_id:leaf.room_id,message_id:leaf.id,revision:leaf.revision},view_position:'40',source_membership_version:'leaf-grant',excerpt:{author:leaf.author,text:leaf.text,created_at:leaf.created_at,revision:leaf.revision,membership_version:'leaf-grant',files:leaf.files}};
    parent.quotes=[child];reply.quotes![0].reference.revision='26';reply.quotes![0].view_position='40';
    Object.assign(reply.quotes![0].excerpt!,{revision:'26',references:[child.reference],quotes:[child]});
    snapshot.rooms.push(room('leaf-room','1','leaf-grant'));snapshot.messages.unshift(leaf);
    await h.store.applySnapshot(snapshot);
    const tree=(await cards(h))[0];assert.equal(tree.attachments?.[0].text,leaf.text);
    const raw=h.db.prepare("SELECT payload FROM native_quote_sources WHERE id='source'").get()!.payload as string;
    assert.ok(!raw.includes(leaf.text),'parent cache may keep references but no private descendant copy');
    assert.ok(!raw.includes('leaf-file'));assert.equal((await h.store.fileAccess('leaf-file'))?.membership,'leaf-grant');
    await h.store.applyBatch(batch([{type:'room_removed',data:{room_id:'leaf-room'}}]));
    const hidden=(await cards(h))[0];assert.equal(hidden.text,parent.text);assert.equal(hidden.attachments?.[0].native_unavailable,true);assert.equal(hidden.attachments?.[0].text,'');
    assert.ok(!JSON.stringify(h.db.prepare('SELECT payload FROM native_quote_sources').all()).includes(leaf.text));
    assert.equal(await h.store.fileAccess('leaf-file'),null);
    await h.store.ingest([reply]);assert.equal((await cards(h))[0].attachments?.[0].native_unavailable,true);
    assert.ok(!JSON.stringify(h.db.prepare('SELECT payload FROM native_quote_sources').all()).includes(leaf.text));
    h.db.close();h=setup(filename,false);assert.equal((await cards(h))[0].attachments?.[0].native_unavailable,true);
    assert.equal((await h.store.state())?.cursor,'next');
  }finally{h.db.close();unlinkSync(filename);rmdirSync(directory);}
});

test('mobile quoted outbox keeps the body and existing cards after source loss, restart and reset',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rv-quoted-outbox-')),filename=join(dir,'cache.sqlite');
  let h=nativeTestDatabase(filename);
  try {
    let store=new NativeStore(h.adapter,creerFileEcritures(),session);await store.applySnapshot(initial());
    const selected=await store.quoteSelection('origin','source');
    await store.enqueue('pending-reply','destination','',{membership:'destination-grant'},[selected]);
    const refs=[selected.reference],pending={id:'pending-reply',rid:'destination',texte:'',quotes:refs};
    assert.deepEqual(await store.pending(),[pending]);
    const pieces=()=>JSON.parse((h.db.prepare("SELECT pieces_jointes FROM messages WHERE id='pending-reply'").get()!.pieces_jointes??'[]') as string) as NativeQuoteAttachment[];
    assert.equal(pieces()[0].text,'*Privé* _texte_ :rocket:');
    await store.applyBatch(batch([{type:'room_removed',data:{room_id:'origin'}}]));
    await store.applySnapshot({protocol_version:1,rooms:[room('destination','1','destination-grant')],messages:[],cursor:'reset'});
    h.db.close();h=nativeTestDatabase(filename,false);store=new NativeStore(h.adapter,creerFileEcritures(),session);
    assert.deepEqual(await store.pending(),[pending]);assert.equal(pieces()[0].native_unavailable,true);assert.equal(pieces()[0].text,'');
    const raw=h.db.prepare('SELECT payload FROM native_outbox_quotes').get()!.payload as string;
    assert.ok(!raw.includes('Privé') && !raw.includes('membership') && !raw.includes('epoch'));
    await store.fail('pending-reply','quote_revision_conflict');await store.retry('pending-reply');assert.deepEqual(await store.pending(),[pending]);
    await store.abandon('pending-reply');assert.deepEqual(await store.pending(),[]);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM native_quote_references WHERE message_id='pending-reply'").get()!.n,0);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM native_outbox_quotes').get()!.n,0);
  }finally {h.db.close();unlinkSync(filename);rmdirSync(dir);}
});

test('mobile source selections are checked atomically and cannot capture an old grant, revision or generation',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const selected=await h.store.quoteSelection('origin','source');
    for(const invalid of [{...selected,data_epoch:'other'},{...selected,instance_id:'other'},{...selected,membership_version:'other'},{...selected,reference:{...selected.reference,revision:'9'}},{...selected,reference:{...selected.reference,room_id:'destination'}}]){
      await assert.rejects(h.store.enqueue('pending','destination','Saved words',undefined,[invalid]));
      assert.deepEqual(await h.store.pending(),[]);assert.equal(h.db.prepare("SELECT id FROM messages WHERE id='pending'").get(),undefined);
    }
    await assert.rejects(h.store.enqueue('pending','destination','Saved words',{membership:'old-destination'},[selected]));
    h.failWhen(sql=>sql.startsWith('INSERT INTO native_outbox_quotes'));
    await assert.rejects(h.store.enqueue('pending','destination','Saved words',undefined,[selected]));h.failWhen(null);
    assert.deepEqual(await h.store.pending(),[]);assert.equal(h.db.prepare("SELECT count(*) AS n FROM native_quote_references WHERE message_id='pending'").get()!.n,0);
    await h.store.ingest([message('source','origin','30','Updated')]);await assert.rejects(h.store.enqueue('pending','destination','Saved words',undefined,[selected]));
    const current=await h.store.quoteSelection('origin','source');await assert.rejects(h.store.enqueue('pending','destination','Saved words',undefined,[current,current]));
  }finally {h.db.close();}
});

test('mobile durable edits preserve ordered references after source withdrawal, reset and SQLite restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rv-quote-edit-')),filename=join(dir,'cache.sqlite');
  let harness=nativeTestDatabase(filename);
  try {
    let store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    const snapshot=initial(),second=structuredClone(snapshot.messages[1].quotes![0]);
    second.reference.message_id='source-two';second.reference.revision='9007199254740993';second.excerpt=null;
    snapshot.messages[1].quotes!.push(second);
    const refs=snapshot.messages[1].quotes!.map(q=>q.reference);
    await store.applySnapshot(snapshot);
    await store.applyBatch(batch([{type:'room_removed',data:{room_id:'origin'}}]));
    assert.equal(await store.command('destination','reply','19','edit','Stale',()=> 'stale'),null);
    assert.equal(await store.hasCommandRevisionConflict('reply'),true);assert.equal(await store.commandDraft('reply'),'Stale');
    const pending=(await store.command('destination','reply','20','edit','Saved edit',()=> 'edit-intent'))!;
    assert.deepEqual(pending.quotes,refs);
    const raw=harness.db.prepare('SELECT quotes FROM native_commands').get()!.quotes as string;
    assert.ok(!raw.includes('Privé') && !raw.includes('membership') && !raw.includes('author'));
    const updated={...message('reply','destination','50','Another version'),position:'20'};
    await store.applySnapshot({protocol_version:1,rooms:[room('destination','1','destination-grant')],messages:[updated],cursor:'reset'});
    harness.db.close();harness=nativeTestDatabase(filename,false);
    store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    const replay=(await store.command('destination','reply','50','edit','Saved edit',()=> {throw new Error('Must retain original intent');}))!;
    assert.equal(replay.id,pending.id);assert.equal(replay.expected_revision,'20');assert.deepEqual(replay.quotes,refs);
    assert.deepEqual((await store.pendingCommands())[0].quotes,refs);
    await store.failCommand(replay.id,'revision_conflict');assert.equal(await store.commandDraft('reply'),'Saved edit');
    assert.deepEqual((await store.command('destination','reply','50','edit','New edit',()=> 'fresh-intent'))!.quotes,[]);
  }finally {harness.db.close();unlinkSync(filename);rmdirSync(dir);}
});

test('quote resolutions preserve exact stamps and keep legacy views distinguishable',()=>{
  const legacy={reference:{room_id:'origin',message_id:'source',revision:'1'},excerpt:null};
  const old=decodeNative('MessageQuote',legacy);
  assert.equal(old.view_position,undefined);
  assert.equal(old.source_membership_version,undefined);
  const current={...legacy,view_position:'9007199254740993',source_membership_version:'current-grant'};
  assert.deepEqual(decodeNative('MessageQuote',current),current);
  assert.throws(()=>decodeNative('MessageQuote',{...current,view_position:9007199254740993}),/Invalid RocketVibe/);
  assert.throws(()=>decodeNative('MessageQuote',{...current,source_membership_version:123}),/Invalid RocketVibe/);
});

test('mobile SQLite refreshes the existing cards independently of reply revisions',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());assert.equal((await cards(h))[0].author_name,'alice');
    await h.store.ingest([message('source','origin','30','Nouvelle source')]);
    await h.store.ingest([initial().messages[1]]);assert.equal((await cards(h))[0].text,'Nouvelle source');
    const older=initial().messages[1];older.revision='19';older.text='Ancienne réponse';older.quotes![0].view_position='40';older.quotes![0].excerpt!.revision='35';older.quotes![0].excerpt!.text='Source manquée par la socket';
    await h.store.ingest([older]);assert.equal((await cards(h))[0].text,'Source manquée par la socket');
    assert.equal((await h.adapter.getFirstAsync<{texte:string}>('SELECT texte FROM messages WHERE id=?',['reply']))!.texte,'Ma réponse');
  }finally {h.db.close();}
});

test('unavailable views win ties and old mobile echoes cannot restore a deleted excerpt',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const missing=initial().messages[1];missing.quotes![0].view_position='40';missing.quotes![0].excerpt=null;
    await h.store.ingest([missing]);await unavailable(h);
    await h.store.ingest([initial().messages[1]]);await unavailable(h);
    const tied=initial().messages[1];tied.quotes![0].view_position='40';await h.store.ingest([tied]);await unavailable(h);
    const legacy=initial().messages[1];delete legacy.quotes![0].view_position;delete legacy.quotes![0].source_membership_version;
    await h.store.ingest([legacy]);await unavailable(h);
    await h.store.ingest([message('source','origin','35','Ancienne source')]);await unavailable(h);
    await h.store.ingest([{...message('source','origin','45',''),deleted:true}]);
    await h.store.ingest([message('source','origin','10','Source tardive')]);await unavailable(h);
    const edited=message('reply','destination','50','Réponse sans citation');edited.position='20';
    await h.store.ingest([edited]);await h.store.ingest([initial().messages[1]]);assert.deepEqual(await cards(h),[]);
  }finally {h.db.close();}
});

test('withdrawal and rejoin purge cross-room cards and fence previous mobile requests',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const token=h.store.projectionToken();
    await h.store.applyBatch(batch([{type:'room_removed',data:{room_id:'origin'}}]));await unavailable(h);
    assert.equal((await h.adapter.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM native_quote_sources WHERE rid=?',['origin']))!.n,0);
    assert.equal(await h.store.ingest([initial().messages[1]],token),false);
    await h.store.applyBatch(batch([{type:'room_upsert',data:room('origin','40','new-grant')}])) ;
    await h.store.ingest([message('source','origin','10','Source relue sous la nouvelle adhésion')]);
    const old=initial().messages[1];old.quotes![0].view_position='999';await h.store.ingest([old]);
    assert.equal((await cards(h))[0].text,'Source relue sous la nouvelle adhésion');
    const absent=initial().messages[1];absent.quotes![0].view_position='30';absent.quotes![0].source_membership_version=null;absent.quotes![0].excerpt=null;
    await h.store.ingest([absent]);assert.equal((await cards(h))[0].native_unavailable,false);
    absent.quotes![0].view_position='50';await h.store.ingest([absent]);await unavailable(h);
    await h.store.ingest([message('source','origin','11','Ancienne trame')]);await unavailable(h);
    await h.store.applyBatch(batch([{type:'room_upsert',data:room('origin','55','third-grant')},{type:'message_upsert',data:message('source','origin','60','Source réautorisée')}])) ;
    assert.equal((await cards(h))[0].text,'Source réautorisée');
  }finally {h.db.close();}
});

test('a missed removal still purges mobile quotes when the source lifetime changes',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const token=h.store.projectionToken();
    await h.store.applyBatch(batch([{type:'room_upsert',data:room('origin','40','new-grant')}])) ;
    await unavailable(h);assert.ok(h.store.projectionToken()>token);
    await h.store.ingest([initial().messages[1]]);await unavailable(h);
  }finally {h.db.close();}
});

test('quote data, source updates and the cursor roll back in one mobile transaction',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const before=await cards(h),bad=initial().messages[1];
    bad.quotes![0].view_position='40';bad.quotes![0].excerpt!.membership_version='wrong-grant';
    await assert.rejects(h.store.applyBatch(batch([{type:'message_upsert',data:message('source','origin','30','À annuler')},{type:'message_upsert',data:bad}])));
    assert.deepEqual(await cards(h),before);assert.equal((await h.store.state())!.cursor,'initial');
    h.failWhen(sql=>sql.startsWith('INSERT INTO native_sync_state'));
    await assert.rejects(h.store.applyBatch(batch([{type:'message_upsert',data:message('source','origin','30','À annuler')}])));
    assert.deepEqual(await cards(h),before);assert.equal((await h.store.state())!.cursor,'initial');
  }finally {h.db.close();}
});

test('mobile quote views survive disk reopen but reset and a new epoch discard old sources',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rv-mobile-quotes-')),filename=join(dir,'cache.sqlite');
  const original=nativeTestDatabase(filename);let reopened:ReturnType<typeof nativeTestDatabase>|undefined;
  try {
    const first=new NativeStore(original.adapter,creerFileEcritures(),session);await first.applySnapshot(initial());original.db.close();
    reopened=nativeTestDatabase(filename,false);const store=new NativeStore(reopened.adapter,creerFileEcritures(),session);
    const h={...reopened,store};assert.equal((await cards(h))[0].author_name,'alice');
    const reset=initial();reset.messages=[reset.messages[1]];reset.messages[0].quotes![0].view_position='40';reset.messages[0].quotes![0].excerpt=null;
    await store.applySnapshot(reset);await unavailable(h);
    const next=new NativeStore(reopened.adapter,creerFileEcritures(),{...session,nativeDataEpoch:'other-epoch'});
    await next.prepare();assert.equal((await reopened.adapter.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM native_quote_sources',[]))!.n,0);
    const snapshot=initial();snapshot.rooms=snapshot.rooms.filter(r=>r.id==='destination');snapshot.messages=[snapshot.messages[1]];
    await next.applySnapshot(snapshot);await unavailable({...h,store:next});
  }finally {reopened?.db.close();if(!reopened)original.db.close();unlinkSync(filename);rmdirSync(dir);}
});

test('malformed quote IDs, room collisions, positions and bounds never partially change the mobile cache',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const before=await cards(h);
    for(let mutation=0;mutation<5;mutation++){
      const bad=initial().messages[1];bad.revision='50';
      switch(mutation){
        case 0:bad.quotes![0].view_position='9223372036854775808';break;
        case 1:bad.quotes![0].reference.room_id='destination';break;
        case 2:bad.quotes![0].reference.revision='01';break;
        case 3:bad.quotes![0].reference.message_id='../source';break;
        default:bad.quotes=Array.from({length:9},()=>structuredClone(bad.quotes![0]));
      }
      await assert.rejects(h.store.ingest([bad]));assert.deepEqual(await cards(h),before);
    }
  }finally {h.db.close();}
});

test('quote order is durable and one source grant loss clears every excerpt in that origin',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());await h.store.ingest([message('second-source','origin','15','Deuxième source')]);
    const reply=initial().messages[1];reply.revision='40';const second=structuredClone(reply.quotes![0]);
    second.reference.message_id='second-source';second.reference.revision='15';second.view_position='40';second.excerpt!.revision='15';second.excerpt!.text='Deuxième source';
    reply.quotes!.unshift(second);await h.store.ingest([reply]);await h.store.ingest([initial().messages[1]]);
    assert.deepEqual((await cards(h)).map(c=>c.text),['Deuxième source','*Privé* _texte_ :rocket:']);
    reply.quotes![0].view_position='50';reply.quotes![0].source_membership_version=null;reply.quotes![0].excerpt=null;
    await h.store.ingest([reply]);assert.ok((await cards(h)).every(c=>c.native_unavailable && c.author_name===undefined && c.text===''));
    assert.equal((await h.adapter.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM native_quote_sources WHERE rid=? AND payload IS NOT NULL',['origin']))!.n,0);
  }finally {h.db.close();}
});

test('mobile quote positions remain exact and source excerpts clip by Unicode code point',async()=>{
  const h=setup();try {
    await h.store.applySnapshot(initial());const latest=initial().messages[1];
    latest.quotes![0].view_position='9007199254740993';latest.quotes![0].excerpt!.revision='9007199254740993';latest.quotes![0].excerpt!.text='Exact';
    await h.store.ingest([latest]);latest.quotes![0].view_position='9007199254740992';latest.quotes![0].excerpt=null;
    await h.store.ingest([latest]);assert.equal((await cards(h))[0].text,'Exact');
    await h.store.ingest([message('source','origin','9007199254740994','🚀'.repeat(1025))]);
    assert.equal((await cards(h))[0].text,'🚀'.repeat(1024));
  }finally {h.db.close();}
});
