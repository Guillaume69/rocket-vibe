import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ClientRest} from './rest.ts';
import type {Fournisseur} from './fournisseur.ts';
import type {PreviewAccess} from '../fournisseurs/rocketvibe/linkPreviews.ts';
import {abonnerApercuNatif,chargerApercuNatif,exporterApercuNatif,monterApercusNatifs,photoApercuNatif,uriApercuNatif} from './apercusNatifs.ts';

const file='a'.repeat(64),png:Uint8Array=new Uint8Array([137,80,78,71]);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function setup(){
  const client=new ClientRest('https://native.example');client.genre='rocketvibe';
  let version=0,scope='same-membership',allowed=true,calls=0;
  const listeners=new Set<()=>void>();
  const access=(key:string):PreviewAccess=>({message:key.split('/')[0],room:'room',image:{file_id:key.split('/')[1],sha256:'b'.repeat(64),bytes:'4',width:1,height:1,media_type:'image/png'},scope});
  const chat={get previewVersion(){return String(version);},get previewsActive(){return allowed;},
    subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    previewAccesses:async(keys:readonly string[])=>new Map(allowed?keys.map(key=>[key,access(key)]):[]),
    previewImage:async(_key:string)=>{calls++;return {bytes:png,scope};},
  };
  const stop=monterApercusNatifs(client,{native:{chat}} as unknown as Fournisseur);
  const change=(grant=true,next=scope)=>{allowed=grant;scope=next;version++;for(const fn of listeners)fn();};
  return {client,chat,stop,change,calls:()=>calls};
}
const flush=()=>new Promise<void>(r=>setImmediate(r));

test('preview handles deduplicate HTTP, survive unrelated revisions and remove pixels before a changed grant',async()=>{
  const h=setup();try{
    const uri=uriApercuNatif(h.client,'message',file)!;assert.match(uri,/^rv-preview:\d+:message\/[a-f0-9]{64}$/);assert(!uri.includes(h.client.baseUrl));
    const a=chargerApercuNatif(uri),b=chargerApercuNatif(uri);assert.equal(a,b);await a;const pixels=photoApercuNatif(uri).uri;assert(pixels);assert.equal(h.calls(),1);
    h.change();assert.equal(photoApercuNatif(uri).uri,null);await flush();assert.equal(photoApercuNatif(uri).uri,pixels);assert.equal(h.calls(),1);
    h.change(true,'new-membership');assert.equal(photoApercuNatif(uri).uri,null);await flush();assert.equal(photoApercuNatif(uri).uri,null);await chargerApercuNatif(uri);assert.equal(h.calls(),2);
    h.change(false);assert.equal(photoApercuNatif(uri).uri,null);await flush();await chargerApercuNatif(uri);assert.equal(h.calls(),2);
  }finally{h.stop();}
});

test('a revoked or unmounted source rejects late reads and cannot revive an earlier account handle',async()=>{
  const h=setup(),wait=deferred<{bytes:Uint8Array;scope:string}>();h.chat.previewImage=()=>wait.promise;
  const uri=uriApercuNatif(h.client,'message',file)!;let notifications=0;const un=abonnerApercuNatif(uri,()=>{notifications++;});
  const read=chargerApercuNatif(uri);h.change(false);await flush();wait.resolve({bytes:png,scope:'same-membership'});await read;assert.equal(photoApercuNatif(uri).uri,null);
  h.stop();assert(notifications>0);assert.equal(uriApercuNatif(h.client,'message',file),null);assert.equal(photoApercuNatif(uri).uri,null);un();
});

test('entries created during grant revalidation stay readable and an old async result cannot override revocation',async()=>{
  const h=setup(),wait=deferred<Map<string,PreviewAccess>>();h.chat.previewAccesses=()=>wait.promise;
  try{
    const old=uriApercuNatif(h.client,'message',file)!;await chargerApercuNatif(old);h.change();
    const next=uriApercuNatif(h.client,'next',file)!;photoApercuNatif(next);await chargerApercuNatif(next);assert(photoApercuNatif(next).uri);
    h.change(false);wait.resolve(new Map());await flush();assert.equal(photoApercuNatif(old).uri,null);assert.equal(photoApercuNatif(next).uri,null);
  }finally{h.stop();}
});

test('four reads run concurrently and idle entries stay bounded',async()=>{
  const h=setup(),releases:(()=>void)[]=[];let active=0,peak=0;
  h.chat.previewImage=async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>releases.push(r));active--;return{bytes:png,scope:'same-membership'};};
  try{
    const uris=Array.from({length:12},(_,i)=>uriApercuNatif(h.client,`message${i}`,file)!);const reads=uris.map(chargerApercuNatif);assert.equal(active,4);
    while(releases.length){releases.shift()!();await flush();}await Promise.all(reads);assert.equal(peak,4);
    for(let i=12;i<160;i++)photoApercuNatif(uriApercuNatif(h.client,`message${i}`,file)!);
    assert.equal(photoApercuNatif(uris[0]).uri,null);assert.equal(uriApercuNatif(h.client,'../message',file),null);assert.equal(uriApercuNatif(h.client,'message','bad'),null);
  }finally{h.stop();}
});

test('an explicit export rereads the live message and exposes a grant check for the gallery writer',async()=>{
  const h=setup();try{
    const uri=uriApercuNatif(h.client,'message',file)!;await chargerApercuNatif(uri);
    const result=await exporterApercuNatif(uri,async(bytes,valid)=>{assert.deepEqual(bytes,png);assert(await valid());h.change(false);assert.equal(await valid(),false);return 'copied';});
    assert.equal(result,'copied');assert.equal(h.calls(),2);
    h.stop();await assert.rejects(exporterApercuNatif(uri,async()=>true),/preview_scope_closed/);
  }finally{h.stop();}
});

test('replacing the reader for a reused client retires all handles from the previous account',async()=>{
  const h=setup();let replacement:()=>void=()=>{};
  try{
    const uri=uriApercuNatif(h.client,'message',file)!;await chargerApercuNatif(uri);assert(photoApercuNatif(uri).uri);
    replacement=monterApercusNatifs(h.client,{native:{chat:h.chat}} as unknown as Fournisseur);
    assert.equal(photoApercuNatif(uri).uri,null);assert.notEqual(uriApercuNatif(h.client,'message',file),uri);
    h.stop();const next=uriApercuNatif(h.client,'message',file)!;await chargerApercuNatif(next);assert(photoApercuNatif(next).uri);
  }finally{replacement();h.stop();}
});
