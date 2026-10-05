import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {emojiCatalog} from './customEmojis.ts';
import {NativeTransport,NativeError} from './transport.ts';
import {NativeStore} from './store.ts';
import {NativeChat} from './chat.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {Session} from '../../lib/auth.ts';
import type {SetReaction} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const catalog=emojiCatalog(fixture.emoji_catalog);
const session:Session={baseUrl:'http://localhost:3400',authToken:'native-token',userId:'alice-id',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};

test('catalogues reject reserved aliases, duplicate names, unsafe descriptors and imprecise revisions',()=>{
  assert.equal(catalog.items[0].aliases[0],'vibe_parrot');
  for(const changed of [{aliases:['parrot']},{name:'../file'},{file_id:'https://other.example/file'},{bytes:'1048577'},{revision:'9007199254740993'},{sha256:'f'.repeat(63)},{media_type:'image/svg+xml'}]){
    assert.throws(()=>emojiCatalog({...catalog,items:[{...catalog.items[0],...changed}]}));
  }
  assert.throws(()=>emojiCatalog({...catalog,items:[catalog.items[0],{...catalog.items[0],id:'other'}]}));
  assert.throws(()=>emojiCatalog({...catalog,revision:'01'}));
  assert.throws(()=>emojiCatalog({...catalog,revision:'9223372036854775808'}));
});

test('emoji downloads authenticate without URL credentials and reject a corrupt image hash',async()=>{
  const bytes=new Uint8Array([71,73,70,56,57,97]),item={...catalog.items[0],bytes:String(bytes.length),sha256:createHash('sha256').update(bytes).digest('hex')};
  let corrupt=false;
  const transport=new NativeTransport(session.baseUrl,async(input,options)=>{
    const url=new URL(String(input));assert.equal(url.search,'');assert.equal(url.origin,session.baseUrl);
    assert.equal((options!.headers as Record<string,string>).authorization,'Bearer native-token');assert.equal(options!.redirect,'error');
    return url.pathname==='/api/v1/emoji'?new Response(JSON.stringify({...catalog,items:[item]})):new Response(corrupt?new Uint8Array(6):bytes,{headers:{'content-type':'image/gif'}});
  });transport.restore(session.authToken);
  assert.equal((await transport.emojiCatalog()).items[0].sha256,item.sha256);
  assert.deepEqual(await transport.emojiBytes(item),bytes);
  corrupt=true;await assert.rejects(transport.emojiBytes(item),/invalid_emoji_image/);
});

test('a durable revision floor rejects late catalogues and hides names across a changed epoch',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session);
  try{
    await store.applySnapshot(fixture.snapshot);
    assert(await store.saveEmojis(catalog,()=>true));
    assert(await store.invalidateEmojis('9007199254740993',()=>true));
    assert.equal(await store.emojiCatalog(),null);
    assert.equal(await store.saveEmojis(catalog,()=>true),false);
    const next={...catalog,revision:'9007199254740993'};
    assert(await store.saveEmojis(next,()=>true));
    assert.equal((await store.emojiCatalog())!.revision,next.revision);
    h.failWhen(sql=>sql.includes('INSERT INTO native_emoji_catalog'));
    await assert.rejects(store.invalidateEmojis('9007199254740994',()=>true),/Injected/);
    h.failWhen(null);assert.deepEqual(await store.emojiCatalog(),next);
    const successor=new NativeStore(h.adapter,createWriteQueue(),{...session,nativeDataEpoch:'new-epoch'});
    await successor.prepare();assert.equal(await successor.emojiCatalog(),null);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM native_emoji_catalog').get()!.n,0);
  }finally{await store.state();h.db.close();}
});

test('a lost custom reaction retries its canonical name after restart and alias replacement',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rv-custom-reaction-')),filename=join(directory,'account.sqlite');
  let h=nativeTestDatabase(filename),store=new NativeStore(h.adapter,createWriteQueue(),session);
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[fixture.message],cursor:'initial'});
  let remote=catalog,accepted=false,ids=0;
  const calls:SetReaction[]=[];
  const transport={
    discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,reactions:true,custom_emojis:true}}),me:async()=>fixture.session.user,
    emojiCatalog:async()=>remote,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
    setReaction:async(_id:string,input:SetReaction)=>{
      calls.push(input);if(!accepted)throw new NativeError(503,'response_lost');
      return {...fixture.message,revision:'9007199254740994',reactions:input.present?[{emoji:input.emoji,users:[fixture.message.author]}]:[]};
    },
  } as unknown as NativeTransport;
  const create=()=>new NativeChat(session,store,()=>`custom-${++ids}`,{transport,socket:()=>{
    const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
  }});
  let chat=create();
  try{
    await chat.connect();await assert.rejects(chat.react(fixture.room.id,fixture.message.id,':vibe_parrot:',true),/response_lost/);
    chat.stop();await store.state();h.db.close();
    h=nativeTestDatabase(filename,false);store=new NativeStore(h.adapter,createWriteQueue(),session);
    remote={revision:'4',items:[{...catalog.items[0],revision:'4',aliases:['new_alias']}]};accepted=true;chat=create();await chat.connect();
    assert.equal(ids,1);assert.equal(calls.length,2);assert(calls.every(c=>c.operation_id==='custom-1'&&c.emoji==='party_parrot'&&c.present));
    assert.deepEqual(await store.pendingCommands(),[]);
    remote={revision:'5',items:[]};await chat.refreshEmojis();
    await assert.rejects(chat.react(fixture.room.id,fixture.message.id,'party_parrot',true),/unknown_emoji/);
    await chat.react(fixture.room.id,fixture.message.id,'party_parrot',false);
    assert.equal(calls.at(-1)!.emoji,'party_parrot');assert.equal(calls.at(-1)!.present,false);
  }finally{chat.stop();await store.state();h.db.close();assert.equal(dirname(directory),tmpdir());rmSync(directory,{recursive:true,force:true});}
});
