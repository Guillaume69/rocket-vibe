/** Protected native photos: volatile, bounded and scoped to the active provider. */
import type {ClientRest} from './rest.ts';

type Photo={uri:string|null;failed:boolean;revision:number};
type Entry={photo:Photo;listeners:Set<()=>void>;pending:Promise<void>|null;retired:boolean;used:number};
type Source={id:number;read:(id:string)=>Promise<Uint8Array>;entries:Map<string,Entry>;active:number;waiters:(()=>void)[]};
const clients=new WeakMap<ClientRest,Source>(),sources=new Map<number,Source>();
const EMPTY:Photo={uri:null,failed:true,revision:0};
const MAX_ENTRIES=128,MAX_CHARS=32*1024*1024;
let serial=0,tick=0;

function notify(entry:Entry):void {for(const fn of entry.listeners)fn();}
function locate(uri:string|null|undefined):{source:Source;id:string}|null {
  const match=typeof uri==='string'?/^rv-avatar:(\d+):([0-9a-f]{64})$/.exec(uri):null;
  const source=match?sources.get(Number(match[1])):null;
  return source&&match?{source,id:match[2]}:null;
}
function entryFor(source:Source,id:string):Entry|null {
  let entry=source.entries.get(id);
  if(entry)return entry;
  if(source.entries.size>=MAX_ENTRIES){
    const candidate=[...source.entries].filter(([,e])=>!e.listeners.size&&!e.pending).sort((a,b)=>a[1].used-b[1].used)[0];
    if(!candidate)return null;
    source.entries.delete(candidate[0]);
  }
  entry={photo:{uri:null,failed:false,revision:0},listeners:new Set(),pending:null,retired:false,used:++tick};
  source.entries.set(id,entry);return entry;
}
function base64(bytes:Uint8Array):string {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',chunks:string[]=[];
  let part='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i],b=bytes[i+1],c=bytes[i+2];
    part+=alphabet[a>>2]+alphabet[(a&3)<<4|(b??0)>>4]+(b===undefined?'=':alphabet[(b&15)<<2|(c??0)>>6])+(c===undefined?'=':alphabet[c&63]);
    if(part.length>=8192){chunks.push(part);part='';}
  }
  chunks.push(part);return chunks.join('');
}

export function definirAvatarsNatifs(client:ClientRest,read:Source['read']):()=>void {
  const previous=clients.get(client);
  if(previous)remove(previous);
  const source:Source={id:++serial,read,entries:new Map(),active:0,waiters:[]};clients.set(client,source);sources.set(source.id,source);
  return()=>{if(clients.get(client)===source)clients.delete(client);remove(source);};
}
function remove(source:Source):void {
  sources.delete(source.id);
  for(const fn of source.waiters.splice(0))fn();
  for(const entry of source.entries.values()){entry.retired=true;entry.photo=EMPTY;notify(entry);entry.listeners.clear();}
  source.entries.clear();
}
export function uriAvatarNatif(client:ClientRest,id:string|null|undefined):string|null {
  const source=clients.get(client);
  return source&&id&&/^[0-9a-f]{64}$/.test(id)?`rv-avatar:${source.id}:${id}`:null;
}
export function photoAvatarNatif(uri:string|null|undefined):Photo {
  const found=locate(uri);return found?entryFor(found.source,found.id)?.photo??EMPTY:EMPTY;
}
export function abonnerAvatarNatif(uri:string|null|undefined,fn:()=>void):()=>void {
  const found=locate(uri),entry=found?entryFor(found.source,found.id):null;
  if(!entry)return()=>{};
  entry.listeners.add(fn);entry.used=++tick;
  return()=>{entry.listeners.delete(fn);};
}
export function retirerAvatarNatif(client:ClientRest,id:string):void {
  const entry=clients.get(client)?.entries.get(id);
  if(!entry)return;
  entry.retired=true;entry.photo={uri:null,failed:true,revision:entry.photo.revision+1};notify(entry);
}
export function reprendreAvatarsNatifs(client:ClientRest):void {
  for(const entry of clients.get(client)?.entries.values()??[])if(entry.photo.failed&&!entry.retired&&!entry.pending){
    entry.photo={uri:null,failed:false,revision:entry.photo.revision+1};notify(entry);
  }
}
export function revaliderAvatarNatif(client:ClientRest,id:string):void {
  const entry=clients.get(client)?.entries.get(id);
  if(entry&&!entry.retired){entry.photo={uri:null,failed:false,revision:entry.photo.revision+1};notify(entry);}
}
export function chargerAvatarNatif(uri:string|null|undefined):Promise<void> {
  const found=locate(uri),entry=found?entryFor(found.source,found.id):null;
  if(!found||!entry||entry.retired||entry.photo.uri||entry.photo.failed)return Promise.resolve();
  if(entry.pending)return entry.pending;
  const {source,id}=found,revision=entry.photo.revision;
  entry.pending=(async()=>{
    try{
      if(source.active>=4)await new Promise<void>(resolve=>source.waiters.push(resolve));
      else source.active++;
      let bytes:Uint8Array;
      try{
        if(!sources.has(source.id)||entry.retired)return;
        bytes=await source.read(id);
      }finally{
        if(sources.has(source.id)){
          const next=source.waiters.shift();
          if(next)next();else source.active--;
        }
      }
      if(bytes.length>2*1024*1024||bytes.length<8||[137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v))throw new Error('invalid_avatar');
      if(!sources.has(source.id)||entry.retired||entry.photo.revision!==revision)return;
      const data=`data:image/png;base64,${base64(bytes)}`;
      let chars=[...source.entries.values()].reduce((sum,e)=>sum+(e.photo.uri?.length??0),0);
      for(const candidate of [...source.entries.values()].filter(e=>e!==entry&&!e.listeners.size&&e.photo.uri).sort((a,b)=>a.used-b.used)){
        if(chars+data.length<=MAX_CHARS)break;
        chars-=candidate.photo.uri!.length;candidate.photo={uri:null,failed:false,revision:candidate.photo.revision+1};
      }
      if(chars+data.length>MAX_CHARS)throw new Error('avatar_cache_full');
      entry.used=++tick;entry.photo={uri:data,failed:false,revision};
    }catch{
      if(sources.has(source.id)&&!entry.retired&&entry.photo.revision===revision)entry.photo={uri:null,failed:true,revision};
    }finally{
      entry.pending=null;
      if(!entry.retired&&entry.photo.revision!==revision)entry.photo={...entry.photo};
      notify(entry);
    }
  })();
  return entry.pending;
}
