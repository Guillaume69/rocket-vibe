import type {Session} from './auth.ts';
import {nativePushScope} from './nativePushNavigation.ts';

export type RoomLink={rid:string;host:string|null;instanceId:string|null;dataEpoch:string|null;userId:string|null;message:string|null;root:string|null};
const id=(value:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(value);
export function serviceUrl(value:string):string|null {
  try {
    const url=new URL(value.includes('://')?value:`https://${value}`);
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)return null;
    return url.toString().replace(/\/+$/,'');
  } catch {return null;}
}
export function parseRoomLink(value:unknown):RoomLink|null {
  if(typeof value!=='string'||value.length>8192)return null;
  try {
    const url=new URL(value.trim());
    if(url.protocol!=='rocketvibe:'||!['salon','room'].includes(url.hostname)||url.username||url.password||url.port||url.hash)return null;
    const rid=decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g,''));
    if(!id(rid))return null;
    const params=new Map<string,string>();let duplicate=false;
    url.searchParams.forEach((v,k)=>{if(params.has(k))duplicate=true;params.set(k,v);});
    if(duplicate)return null;
    const host=params.has('host')?serviceUrl(params.get('host')!):null;
    if(params.has('host')&&!host)return null;
    let instanceId=params.get('instanceId')??null,dataEpoch=params.get('dataEpoch')??null,userId=params.get('userId')??null;
    if(params.has('nativeScope')) {
      const raw=params.get('nativeScope')!;
      const scope=nativePushScope(raw);
      if(!scope||Object.keys(JSON.parse(raw) as object).some(k=>!['instanceId','dataEpoch','userId'].includes(k)))return null;
      if(instanceId!==null&&instanceId!==scope.instanceId||dataEpoch!==null&&dataEpoch!==scope.dataEpoch||userId!==null&&userId!==scope.userId)return null;
      ({instanceId,dataEpoch,userId}=scope);
    }
    const native=instanceId!==null||dataEpoch!==null||userId!==null;
    if(native&&(!host||!instanceId||!dataEpoch||!id(instanceId)||!id(dataEpoch)))return null;
    const message=params.get('msg')??null,root=params.get('tmid')??null;
    if([userId,message,root].some(v=>v!==null&&!id(v)))return null;
    return {rid,host,instanceId,dataEpoch,userId,message,root};
  } catch {return null;}
}
export function roomLinkMatches(link:RoomLink,session:Session):boolean {
  return (link.instanceId!==null?session.kind==='rocketvibe'&&link.instanceId===session.nativeInstanceId&&link.dataEpoch===session.nativeDataEpoch:session.kind!=='rocketvibe')
    && (link.host===null||link.host===serviceUrl(session.baseUrl)) && (link.userId===null||link.userId===session.userId);
}
export function roomLinkUrl(link:RoomLink):string {
  const url=new URL(`rocketvibe://room/${link.rid}`);
  for(const [key,value] of [['host',link.host],['instanceId',link.instanceId],['dataEpoch',link.dataEpoch],['userId',link.userId],['msg',link.message],['tmid',link.root]] as const)if(value!==null)url.searchParams.set(key,value);
  return url.toString();
}
export function nativeRoomPermalink(session:Session,rid:string,message:string|null=null,root:string|null=null):string|null {
  if(session.kind!=='rocketvibe'||!id(rid)||[message,root].some(v=>v!==null&&!id(v)))return null;
  const host=serviceUrl(session.baseUrl);
  if(!host||!session.nativeInstanceId||!session.nativeDataEpoch)return null;
  const url=new URL(`rocketvibe://room/${rid}`);
  url.searchParams.set('host',host);url.searchParams.set('instanceId',session.nativeInstanceId);url.searchParams.set('dataEpoch',session.nativeDataEpoch);
  if(message!==null)url.searchParams.set('msg',message);
  if(root!==null)url.searchParams.set('tmid',root);
  return parseRoomLink(url.toString())?url.toString():null;
}
/** Mark system URLs so an unscoped external link cannot masquerade as an
 * internal route. No provider is inferred from the currently displayed room. */
export function systemRoomPath(path:string|null):string|null {
  if(!path||!/^rocketvibe:\/\/(salon|room)(\/|\?|$)/i.test(path))return path;
  const link=parseRoomLink(path);
  return `/room/${link?.rid??'invalid'}?roomLink=${encodeURIComponent(link?path:'invalid')}`;
}
