import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {linkPreview,nativeUrls,previewImage,previewKey} from './linkPreviews.ts';
import {NativeTransport} from './transport.ts';
import {NativeStore} from './store.ts';
import {NativeChat} from './chat.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import {linkPreviews,videoMetas} from '../../lib/linkPreview.ts';
import type {Session} from '../../lib/auth.ts';
import type {Message,Room,PreviewImage} from './protocol.generated.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'http://localhost:3400',authToken:'saved-token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64'));
const image:PreviewImage={file_id:'a'.repeat(64),sha256:createHash('sha256').update(png).digest('hex'),bytes:String(png.length),media_type:'image/png',width:1,height:1};
const preview=linkPreview({url:'https://example.org/article',kind:'page',title:'An article',description:'Description',site:'Example',image});
const message:Message={...fixture.message,previews:[preview]};
const room:Room={...fixture.room,read_state:{room_id:fixture.room.id,revision:'1',membership_version:'first-membership',favorite_revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}};
const snapshot={protocol_version:1,rooms:[room],messages:[message],cursor:'initial'};

test('native manifests reject unsafe URLs, descriptors, oversized text and invalid message lists',()=>{
  for(const patch of [{file_id:'../secret'},{sha256:'a'.repeat(63)},{bytes:'01'},{bytes:'4194305'},{width:0},{height:1201},{media_type:'image/svg+xml'}])assert.throws(()=>previewImage({...image,...patch}));
  for(const patch of [{url:'file:///private'},{url:'https://owner:secret@example.org/'},{title:'é'.repeat(257)},{title:'bad\ncontrol'},{title:null,image:null}])assert.throws(()=>linkPreview({...preview,...patch}));
  assert.throws(()=>nativeUrls({...message,previews:[preview,preview]}));
  assert.throws(()=>nativeUrls({...message,deleted:true}));
  assert.throws(()=>nativeUrls({...message,id:'../message'}));
  assert.equal(nativeUrls({...message,previews:[]}),null);
});

test('the existing article, direct-image and video projections use only protected native handles',()=>{
  const resolve=(message:string,file:string)=>`rv-preview:1:${message}/${file}`;
  const cards=linkPreviews(nativeUrls(message),3,resolve);
  assert.deepEqual(cards,[{type:'card',url:preview.url,title:'An article',description:'Description',site:'Example',image:resolve(message.id,image.file_id)}]);
  assert.deepEqual(linkPreviews(nativeUrls(message)),[]);
  const direct={...message,previews:[linkPreview({...preview,kind:'image'})]};
  assert.deepEqual(linkPreviews(nativeUrls(direct),3,resolve),[{type:'image',url:resolve(message.id,image.file_id)}]);
  const video={...message,previews:[linkPreview({...preview,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'})]};
  assert.deepEqual(linkPreviews(nativeUrls(video),3,resolve),[]);
  assert.deepEqual(videoMetas(nativeUrls(video),resolve).get('dQw4w9WgXcQ'),{title:'An article',author:'Example',image:resolve(message.id,image.file_id)});
  const forged=JSON.stringify([{url:preview.url,native_message:message.id,native_preview:{...preview,image:{...image,file_id:'https://outside.example/'}},meta:{ogTitle:'Fallback',ogImage:'https://outside.example/image'}}]);
  assert.deepEqual(linkPreviews(forged,3,resolve),[]);
});

test('SQLite keeps images across unrelated revisions and fences edits, deletion, rollback and rejoining',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session),key=previewKey(message.id,image.file_id);
  try{
    await store.applySnapshot(snapshot);const first=(await store.previewAccesses([key])).get(key)!;assert(first);
    await store.ingest([{...message,revision:'9007199254740994',reactions:[{emoji:'heart',users:[message.author]}]}]);
    assert.equal((await store.previewAccesses([key])).get(key)!.scope,first.scope);
    h.failWhen(sql=>sql.startsWith('INSERT INTO native_sync_state'));
    await assert.rejects(store.applyBatch({protocol_version:1,changes:[{type:'message_upsert',data:{...message,revision:'9007199254740995',previews:[]}}],cursor:'failed',has_more:false}));
    h.failWhen(null);assert.equal((await store.previewAccesses([key])).get(key)!.scope,first.scope);
    await store.ingest([{...message,revision:'9007199254740995',previews:[]}]);assert.equal((await store.previewAccesses([key])).size,0);
    await store.ingest([message]);assert.equal((await store.previewAccesses([key])).size,0);
    await store.applySnapshot({...snapshot,rooms:[{...room,read_state:{...room.read_state!,revision:'2',membership_version:'second-membership'}}]});
    assert.notEqual((await store.previewAccesses([key])).get(key)!.scope,first.scope);
    await store.ingest([{...message,revision:'9007199254740996',deleted:true,text:'',previews:[]}]);assert.equal((await store.previewAccesses([key])).size,0);
  }finally{h.db.close();}
});

test('search previews are temporary, bounded by current membership and do not enlarge confirmed history',async()=>{
  const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session),key=previewKey(message.id,image.file_id);
  try{
    await store.applySnapshot({...snapshot,messages:[]});
    await store.cacheFileViews([message],room.id,room.read_state!.membership_version!,()=>true);
    assert.equal((await store.previewAccesses([key])).get(key)?.message,message.id);assert.deepEqual(await store.messages(room.id),[]);
    await store.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:room.id}}],cursor:'removed',has_more:false});
    assert.equal((await store.previewAccesses([key])).size,0);
    await store.applySnapshot(snapshot);assert.equal((await store.previewAccesses([key])).size,1);
    await assert.rejects(store.cacheFileViews([message],room.id,'old-membership',()=>true));
  }finally{h.db.close();}
});

test('private image HTTP reads pin credentials, validate PNG dimensions and hash, and refuse changed tokens',async()=>{
  let bytes=png,mime='image/png',length=String(png.length),close=false;
  const calls:{url:string;options:RequestInit}[]=[];
  const transport=new NativeTransport('https://native.example',async(input,options)=>{
    calls.push({url:String(input),options:options!});if(close)transport.restore('replacement');
    return new Response(bytes,{headers:{'content-type':mime,'content-length':length}});
  });transport.restore('private-token');
  assert.deepEqual(await transport.previewBytes(message.id,image),png);
  assert.equal(calls[0].url,`https://native.example/api/v1/messages/${message.id}/previews/${image.file_id}`);
  assert.equal(new Headers(calls[0].options.headers).get('authorization'),'Bearer private-token');assert.equal(calls[0].options.redirect,'error');
  for(const invalid of [{...image,sha256:'f'.repeat(64)},{...image,width:2}])await assert.rejects(transport.previewBytes(message.id,invalid),/invalid_preview_image/);
  bytes=png.slice(0,-1);length=String(bytes.length);await assert.rejects(transport.previewBytes(message.id,image));
  bytes=png;length=String(png.length);mime='image/svg+xml';await assert.rejects(transport.previewBytes(message.id,image));
  mime='image/png';length='4194305';await assert.rejects(transport.previewBytes(message.id,image));
  length=String(png.length);close=true;await assert.rejects(transport.previewBytes(message.id,image));
  await assert.rejects(transport.previewBytes('../escape',image));
});

test('the app runner refuses retired, closed or rejoined preview images and observes message revisions',async()=>{
  for(const scenario of ['normal','retired','closed','rejoined'] as const){
    const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session);await store.applySnapshot(snapshot);
    let chat:NativeChat;
    const transport={discover:async()=>({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,link_previews:true}}),me:async()=>fixture.session.user,
      changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://localhost/fake',
      message:async()=>scenario==='retired'?{...message,previews:[]}:message,
      previewBytes:async()=>{if(scenario==='closed')chat.stop();if(scenario==='rejoined')await store.applySnapshot({...snapshot,rooms:[{...room,read_state:{...room.read_state!,revision:'2',membership_version:'new'}}]});return png;},
    } as unknown as NativeTransport;
    chat=new NativeChat(session,store,()=>{throw new Error('No sends');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try{
      await chat.connect();const version=chat.previewVersion;
      await store.ingest([{...message,revision:'9007199254740994'}]);assert.notEqual(chat.previewVersion,version);
      const read=chat.previewImage(previewKey(message.id,image.file_id));
      if(scenario==='normal')assert.deepEqual((await read).bytes,png);else await assert.rejects(read);
    }finally{chat.stop();await store.state();h.db.close();}
  }
});
