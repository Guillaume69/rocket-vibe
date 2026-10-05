/** Volatile protected preview pixels. A SQL grant check precedes cache reuse. */
import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {avatarBase64} from './nativeAvatars.ts';
type Photo={uri:string|null;failed:boolean;revision:number};
type Entry={photo:Photo;scope:string|null;listeners:Set<()=>void>;pending:Promise<void>|null;used:number};
type Source={id:number;client:RestClient;chat:NonNullable<Provider['native']>['chat'];entries:Map<string,Entry>;version:string;active:number;waiters:(()=>void)[];refresh:number;close:()=>void};
const sources=new Map<number,Source>(),clients=new WeakMap<RestClient,Source>();
const EMPTY:Photo={uri:null,failed:true,revision:0};let serial=0,tick=0;
const keyPattern=/^[A-Za-z0-9_-]{1,128}\/[0-9a-f]{64}$/;
function locate(uri:string|null|undefined):{source:Source;key:string}|null {
  const match=uri&&/^rv-preview:(\d+):([A-Za-z0-9_-]{1,128}\/[0-9a-f]{64})$/.exec(uri),source=match?sources.get(Number(match[1])):null;
  return source&&match?{source,key:match[2]}:null;
}
function entry(source:Source,key:string):Entry|null {
  let found=source.entries.get(key);if(found)return found;
  if(source.entries.size>=128){const oldest=[...source.entries].filter(([,e])=>!e.listeners.size&&!e.pending).sort((a,b)=>a[1].used-b[1].used)[0];if(!oldest)return null;source.entries.delete(oldest[0]);}
  found={photo:{uri:null,failed:false,revision:0},scope:null,listeners:new Set(),pending:null,used:++tick};source.entries.set(key,found);return found;
}
function notify(entry:Entry):void {for(const fn of entry.listeners)fn();}
export function nativePreviewUri(client:RestClient,message:string,file:string):string|null {
  const source=clients.get(client),key=`${message}/${file}`;
  return source&&keyPattern.test(key)?`rv-preview:${source.id}:${key}`:null;
}
export function nativePreviewPhoto(uri:string|null|undefined):Photo {const value=locate(uri);return value?entry(value.source,value.key)?.photo??EMPTY:EMPTY;}
export function subscribeNativePreview(uri:string|null|undefined,listener:()=>void):()=>void {
  const value=locate(uri),e=value?entry(value.source,value.key):null;if(!e)return()=>{};
  e.listeners.add(listener);e.used=++tick;return()=>{e.listeners.delete(listener);};
}
export function loadNativePreview(uri:string|null|undefined):Promise<void> {
  const found=locate(uri),e=found?entry(found.source,found.key):null;
  if(!found||!e||e.photo.uri||e.photo.failed)return Promise.resolve();if(e.pending)return e.pending;
  const {source,key}=found,revision=e.photo.revision;
  e.pending=(async()=>{
    try{
      if(source.active>=4)await new Promise<void>(resolve=>source.waiters.push(resolve));else source.active++;
      let read:Awaited<ReturnType<Source['chat']['previewImage']>>;
      try{if(!sources.has(source.id))return;if(!source.chat.previewsActive)throw new Error('preview_scope_closed');read=await source.chat.previewImage(key);}
      finally{if(sources.has(source.id)){const next=source.waiters.shift();if(next)next();else source.active--;}}
      if(!sources.has(source.id)||e.photo.revision!==revision)return;
      if(read.bytes.length>4*1024*1024)throw new Error('preview_too_large');
      const data=`data:image/png;base64,${avatarBase64(read.bytes)}`;
      let size=[...source.entries.values()].reduce((n,e)=>n+(e.photo.uri?.length??0),0);
      for(const idle of [...source.entries.values()].filter(other=>other!==e&&!other.listeners.size&&other.photo.uri).sort((a,b)=>a.used-b.used)){
        if(size+data.length<=32*1024*1024)break;size-=idle.photo.uri!.length;idle.photo={uri:null,failed:false,revision:idle.photo.revision+1};idle.scope=null;
      }
      if(size+data.length>32*1024*1024)throw new Error('preview_cache_full');
      e.scope=read.scope;e.photo={uri:data,failed:false,revision};e.used=++tick;
    }catch{if(sources.has(source.id)&&e.photo.revision===revision)e.photo={uri:null,failed:true,revision};}
    finally{e.pending=null;notify(e);}
  })();return e.pending;
}
/** Explicit export rechecks the current message rather than reusing rendered pixels. */
export async function exportNativePreview<T>(uri:string,write:(bytes:Uint8Array,valid:()=>Promise<boolean>)=>Promise<T>):Promise<T> {
  const found=locate(uri);if(!found)throw new Error('preview_scope_closed');
  const {source,key}=found,read=await source.chat.previewImage(key);
  const valid=async()=>sources.get(source.id)===source&&source.chat.previewsActive&&(await source.chat.previewAccesses([key])).get(key)?.scope===read.scope;
  if(read.bytes.length>4*1024*1024||!await valid())throw new Error('preview_scope_closed');
  return write(read.bytes,valid);
}
export function mountNativePreviews(client:RestClient,provider:Provider):()=>void {
  const chat=provider.native?.chat;if(!chat)return()=>{};
  clients.get(client)?.close();
  const source:Source={id:++serial,client,chat,entries:new Map(),version:chat.previewVersion,active:0,waiters:[],refresh:0,close:()=>{}};
  sources.set(source.id,source);clients.set(client,source);
  const refresh=()=>{
    if(source.version===chat.previewVersion)return;source.version=chat.previewVersion;
    const version=++source.refresh,saved=new Map<string,{uri:string|null;scope:string|null}>();
    for(const [key,e] of source.entries){saved.set(key,{uri:e.photo.uri,scope:e.scope});e.photo={uri:null,failed:true,revision:e.photo.revision+1};notify(e);}
    void chat.previewAccesses([...source.entries.keys()]).then(access=>{
      if(!sources.has(source.id)||source.refresh!==version)return;
      for(const [key,old] of saved){const e=source.entries.get(key);if(!e)continue;const current=access.get(key);e.scope=current?.scope??null;e.photo={uri:current&&old.scope===current.scope?old.uri:null,failed:!current,revision:e.photo.revision};notify(e);}
    }).catch(()=>{});
  };
  const unlisten=chat.subscribe(refresh);
  source.close=()=>{unlisten();sources.delete(source.id);if(clients.get(client)===source)clients.delete(client);for(const resume of source.waiters.splice(0))resume();for(const e of source.entries.values()){e.photo=EMPTY;e.scope=null;notify(e);e.listeners.clear();}source.entries.clear();};
  return source.close;
}
