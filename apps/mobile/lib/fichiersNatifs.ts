/** Volatile handles to the active account, never bearer tokens in media URLs. */
import type {ClientRest} from './rest.ts';
type Source={id:number;read:(id:string,progress?:(fraction:number)=>void)=>Promise<string>;subscribe?:(fn:()=>void)=>()=>void;version:()=>number};
const clients=new WeakMap<ClientRest,Source>(),sources=new Map<number,Source>();let serial=0;
export function definirFichiersNatifs(client:ClientRest,read:Source['read'],subscribe?:Source['subscribe'],version:()=>number=()=>0):()=>void {
  const old=clients.get(client);if(old)sources.delete(old.id);
  const source={id:++serial,read,subscribe,version};clients.set(client,source);sources.set(source.id,source);
  return()=>{sources.delete(source.id);if(clients.get(client)===source)clients.delete(client);};
}
export function abonnerFichierNatif(uri:string,listener:()=>void):()=>void {
  const match=/^rv-file:(\d+):/.exec(uri);return match?sources.get(Number(match[1]))?.subscribe?.(listener)??(()=>{}):()=>{};
}
export function uriFichierNatif(client:ClientRest,path:string):string {
  const match=/^\/api\/v1\/files\/([A-Za-z0-9_-]{1,128})$/.exec(path),source=clients.get(client);
  return source&&match?`rv-file:${source.id}:${match[1]}:${source.version()}`:'rv-file:unavailable';
}
export async function chargerFichierNatif(uri:string,progress?:(fraction:number)=>void):Promise<string>{
  const match=/^rv-file:(\d+):([A-Za-z0-9_-]{1,128}):(\d+)$/.exec(uri),source=match?sources.get(Number(match[1])):null;
  if(!source||!match||source.version()!==Number(match[3]))throw new Error('file_scope_closed');
  const local=await source.read(match[2],progress);
  if(sources.get(source.id)!==source||source.version()!==Number(match[3])||!local.startsWith('file://'))throw new Error('file_scope_closed');
  return local;
}
