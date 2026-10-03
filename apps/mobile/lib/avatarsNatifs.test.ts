import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ClientRest} from './rest.ts';
import {urlAvatar} from './upload.ts';
import {abonnerAvatarNatif,chargerAvatarNatif,definirAvatarsNatifs,photoAvatarNatif,reprendreAvatarsNatifs,retirerAvatarNatif,uriAvatarNatif,revaliderAvatarNatif} from './avatarsNatifs.ts';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,127,255]);
const id='a'.repeat(64);
function client():ClientRest {const c=new ClientRest('https://native.example');c.genre='rocketvibe';return c;}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}

test('protected avatar identifiers never contain credentials; visible reads are deduplicated and encoded correctly',async()=>{
  const c=client();let calls=0;const pending=deferred<Uint8Array>();
  const stop=definirAvatarsNatifs(c,async()=>{calls++;return pending.promise;});
  try{
    const uri=urlAvatar(c,{uid:'owner',etag:id})!;
    assert.match(uri,/^rv-avatar:\d+:[a-f0-9]{64}$/);assert.equal(uri.includes(c.baseUrl),false);
    assert.equal(urlAvatar(c,{rid:'room',etag:id}),null);assert.equal(urlAvatar(c,{etag:'../file'}),null);
    const a=chargerAvatarNatif(uri),b=chargerAvatarNatif(uri);assert.equal(a,b);assert.equal(calls,1);
    pending.resolve(png);await a;
    assert.equal(photoAvatarNatif(uri).uri,`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  }finally{stop();}
});
test('leaving an account and retiring a photo clear rendered pixels and refuse late downloads',async()=>{
  const c=client(),wait=deferred<Uint8Array>();let stopped=definirAvatarsNatifs(c,()=>wait.promise);
  const old=uriAvatarNatif(c,id)!;let notifications=0;const un=abonnerAvatarNatif(old,()=>{notifications++;});
  const download=chargerAvatarNatif(old);stopped();
  assert.equal(photoAvatarNatif(old).uri,null);assert.equal(uriAvatarNatif(c,id),null);assert(notifications>0);
  stopped=definirAvatarsNatifs(c,async()=>png);
  const next=uriAvatarNatif(c,id)!;assert.notEqual(old,next);
  wait.resolve(png);await download;assert.equal(photoAvatarNatif(old).uri,null);
  await chargerAvatarNatif(next);assert(photoAvatarNatif(next).uri);
  retirerAvatarNatif(c,id);assert.equal(photoAvatarNatif(next).uri,null);
  reprendreAvatarsNatifs(c);await chargerAvatarNatif(next);assert.equal(photoAvatarNatif(next).uri,null);
  un();stopped();
});
test('failed photos retry after reconnection, and revalidation fences a download already in flight',async()=>{
  const c=client();let attempts=0;const wait=deferred<Uint8Array>();
  const stop=definirAvatarsNatifs(c,async()=>{attempts++;if(attempts===1)throw new Error('offline');if(attempts===2)return wait.promise;return png;});
  try{
    const uri=uriAvatarNatif(c,id)!;await chargerAvatarNatif(uri);assert.equal(photoAvatarNatif(uri).failed,true);
    await chargerAvatarNatif(uri);assert.equal(attempts,1);
    reprendreAvatarsNatifs(c);const download=chargerAvatarNatif(uri);revaliderAvatarNatif(c,id);
    wait.resolve(png);await download;assert.equal(photoAvatarNatif(uri).uri,null);
    await chargerAvatarNatif(uri);assert(photoAvatarNatif(uri).uri);assert.equal(attempts,3);
  }finally{stop();}
});
test('avatar loading limits concurrent HTTP reads and bounds idle memory entries',async()=>{
  const c=client();let active=0,peak=0;const releases:(()=>void)[]=[];
  const stop=definirAvatarsNatifs(c,async()=>{active++;peak=Math.max(active,peak);await new Promise<void>(r=>releases.push(r));active--;return png;});
  try{
    const uris=Array.from({length:12},(_,i)=>uriAvatarNatif(c,i.toString(16).padStart(64,'0'))!);
    const pending=uris.map(chargerAvatarNatif);assert.equal(active,4);
    while(releases.length){releases.shift()!();await new Promise<void>(r=>setImmediate(r));}
    await Promise.all(pending);assert.equal(peak,4);
    for(let i=12;i<200;i++)photoAvatarNatif(uriAvatarNatif(c,i.toString(16).padStart(64,'0'))!);
    assert.equal(photoAvatarNatif(uris[0]).uri,null);
  }finally{stop();}
});

test('visible photos cannot exceed the memory budget when every cached tile is subscribed',async()=>{
  const c=client(),bytes=new Uint8Array(2*1024*1024);bytes.set(png);
  const stop=definirAvatarsNatifs(c,async()=>bytes),subscriptions:(()=>void)[]=[];
  try{
    const uris=Array.from({length:13},(_,i)=>uriAvatarNatif(c,i.toString(16).padStart(64,'0'))!);
    for(const uri of uris){subscriptions.push(abonnerAvatarNatif(uri,()=>{}));await chargerAvatarNatif(uri);}
    assert(uris.some(uri=>photoAvatarNatif(uri).failed));
    assert(uris.reduce((total,uri)=>total+(photoAvatarNatif(uri).uri?.length??0),0)<=32*1024*1024);
  }finally{for(const un of subscriptions)un();stop();}
});
