import type {Session} from './auth.ts';
export type NativePushScope={instanceId:string;dataEpoch:string;userId:string};
export function nativePushScope(value:unknown):NativePushScope|null {
  if(typeof value!=='string'||value.length>1024)return null;
  try {
    const data=JSON.parse(value) as Record<string,unknown>;
    const keys=['instanceId','dataEpoch','userId'] as const;
    if(!data||keys.some(key=>typeof data[key]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(data[key] as string)))return null;
    return {instanceId:data.instanceId as string,dataEpoch:data.dataEpoch as string,userId:data.userId as string};
  } catch {return null;}
}
export function nativePushMatches(scope:NativePushScope,session:Session):boolean {
  return session.genre==='rocketvibe'&&scope.instanceId===session.nativeInstanceId&&scope.dataEpoch===session.nativeDataEpoch&&scope.userId===session.userId;
}
export function nativePushServerUrl(value:unknown):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  try {
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;
    return url.toString().replace(/\/$/,'');
  } catch {return null;}
}
