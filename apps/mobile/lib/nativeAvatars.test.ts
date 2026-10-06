import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestClient} from './rest.ts';
import {avatarUrl} from './upload.ts';
import {subscribeNativeAvatar,loadNativeAvatar,setNativeAvatars,nativeAvatarPhoto,resumeNativeAvatars,removeNativeAvatar,nativeAvatarUri,revalidateNativeAvatar} from './nativeAvatars.ts';
import {setNativeEmojis,nativeEmojiUri,revalidateNativeEmojis} from './nativeAvatars.ts';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,127,255]);
const id='a'.repeat(64);
function client():RestClient {const c=new RestClient('https://native.example');c.kind='rocketvibe';return c;}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}

test('protected avatar identifiers never contain credentials; visible reads are deduplicated and encoded correctly',async()=>{
  const c=client();let calls=0;const pending=deferred<Uint8Array>();
  const stop=setNativeAvatars(c,async()=>{calls++;return pending.promise;});
  try{
    const uri=avatarUrl(c,{uid:'owner',etag:id})!;
    assert.match(uri,/^rv-avatar:\d+:[a-f0-9]{64}$/);assert.equal(uri.includes(c.baseUrl),false);
    assert.equal(avatarUrl(c,{rid:'room',etag:id}),null);assert.equal(avatarUrl(c,{etag:'../file'}),null);
    const a=loadNativeAvatar(uri),b=loadNativeAvatar(uri);assert.equal(a,b);assert.equal(calls,1);
    pending.resolve(png);await a;
    assert.equal(nativeAvatarPhoto(uri).uri,`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  }finally{stop();}
});
test('leaving an account and retiring a photo clear rendered pixels and refuse late downloads',async()=>{
  const c=client(),wait=deferred<Uint8Array>();let stopped=setNativeAvatars(c,()=>wait.promise);
  const old=nativeAvatarUri(c,id)!;let notifications=0;const allRows=subscribeNativeAvatar(old,()=>{notifications++;});
  const download=loadNativeAvatar(old);stopped();
  assert.equal(nativeAvatarPhoto(old).uri,null);assert.equal(nativeAvatarUri(c,id),null);assert(notifications>0);
  stopped=setNativeAvatars(c,async()=>png);
  const next=nativeAvatarUri(c,id)!;assert.notEqual(old,next);
  wait.resolve(png);await download;assert.equal(nativeAvatarPhoto(old).uri,null);
  await loadNativeAvatar(next);assert(nativeAvatarPhoto(next).uri);
  removeNativeAvatar(c,id);assert.equal(nativeAvatarPhoto(next).uri,null);
  resumeNativeAvatars(c);await loadNativeAvatar(next);assert.equal(nativeAvatarPhoto(next).uri,null);
  allRows();stopped();
});
test('failed photos retry after reconnection, and revalidation fences a download already in flight',async()=>{
  const c=client();let attempts=0;const wait=deferred<Uint8Array>();
  const stop=setNativeAvatars(c,async()=>{attempts++;if(attempts===1)throw new Error('offline');if(attempts===2)return wait.promise;return png;});
  try{
    const uri=nativeAvatarUri(c,id)!;await loadNativeAvatar(uri);assert.equal(nativeAvatarPhoto(uri).failed,true);
    await loadNativeAvatar(uri);assert.equal(attempts,1);
    resumeNativeAvatars(c);const download=loadNativeAvatar(uri);revalidateNativeAvatar(c,id);
    wait.resolve(png);await download;assert.equal(nativeAvatarPhoto(uri).uri,null);
    await loadNativeAvatar(uri);assert(nativeAvatarPhoto(uri).uri);assert.equal(attempts,3);
  }finally{stop();}
});
test('avatar loading limits concurrent HTTP reads and bounds idle memory entries',async()=>{
  const c=client();let active=0,peak=0;const releases:(()=>void)[]=[];
  const stop=setNativeAvatars(c,async()=>{active++;peak=Math.max(active,peak);await new Promise<void>(r=>releases.push(r));active--;return png;});
  try{
    const uris=Array.from({length:12},(_,i)=>nativeAvatarUri(c,i.toString(16).padStart(64,'0'))!);
    const pending=uris.map(loadNativeAvatar);assert.equal(active,4);
    while(releases.length){releases.shift()!();await new Promise<void>(r=>setImmediate(r));}
    await Promise.all(pending);assert.equal(peak,4);
    for(let i=12;i<200;i++)nativeAvatarPhoto(nativeAvatarUri(c,i.toString(16).padStart(64,'0'))!);
    assert.equal(nativeAvatarPhoto(uris[0]).uri,null);
  }finally{stop();}
});

test('visible photos cannot exceed the memory budget when every cached tile is subscribed',async()=>{
  const c=client(),bytes=new Uint8Array(2*1024*1024);bytes.set(png);
  const stop=setNativeAvatars(c,async()=>bytes),subscriptions:(()=>void)[]=[];
  try{
    const uris=Array.from({length:13},(_,i)=>nativeAvatarUri(c,i.toString(16).padStart(64,'0'))!);
    for(const uri of uris){subscriptions.push(subscribeNativeAvatar(uri,()=>{}));await loadNativeAvatar(uri);}
    assert(uris.some(uri=>nativeAvatarPhoto(uri).failed));
    assert(uris.reduce((total,uri)=>total+(nativeAvatarPhoto(uri).uri?.length??0),0)<=32*1024*1024);
  }finally{for(const allRows of subscriptions)allRows();stop();}
});

test('custom GIFs share the protected image reader and retire without affecting avatars',async()=>{
  const c=client(),gif=new Uint8Array([71,73,70,56,57,97,0]);
  const unavatar=setNativeAvatars(c,async()=>png),unemoji=setNativeEmojis(c,async()=>({bytes:gif,mime:'image/gif'}));
  try{
    const avatar=nativeAvatarUri(c,id)!,emoji=nativeEmojiUri(c,id)!;
    assert.match(emoji,/^rv-emoji:\d+:[a-f0-9]{64}$/);assert.notEqual(avatar,emoji);
    await Promise.all([loadNativeAvatar(avatar),loadNativeAvatar(emoji)]);
    assert.equal(nativeAvatarPhoto(emoji).uri,`data:image/gif;base64,${Buffer.from(gif).toString('base64')}`);
    revalidateNativeEmojis(c,new Set(),true);assert.equal(nativeAvatarPhoto(emoji).uri,null);assert(nativeAvatarPhoto(avatar).uri);
    revalidateNativeEmojis(c,new Set([id]),true);await loadNativeAvatar(emoji);assert(nativeAvatarPhoto(emoji).uri);
    revalidateNativeEmojis(c,new Set([id]),false);assert.equal(nativeAvatarPhoto(emoji).uri,null);
    revalidateNativeEmojis(c,new Set([id]),true);await loadNativeAvatar(emoji);assert(nativeAvatarPhoto(emoji).uri);
    unemoji();assert.equal(nativeAvatarPhoto(emoji).uri,null);assert(nativeAvatarPhoto(avatar).uri);
  }finally{unemoji();unavatar();}
});
test('a newer catalogue fences an image download that finishes after retirement',async()=>{
  const c=client(),pending=deferred<{bytes:Uint8Array;mime:string}>(),stop=setNativeEmojis(c,()=>pending.promise);
  try{
    const uri=nativeEmojiUri(c,id)!,read=loadNativeAvatar(uri);
    revalidateNativeEmojis(c,new Set(),true);pending.resolve({bytes:png,mime:'image/png'});await read;
    assert.equal(nativeAvatarPhoto(uri).uri,null);await loadNativeAvatar(uri);assert.equal(nativeAvatarPhoto(uri).uri,null);
  }finally{stop();}
});
