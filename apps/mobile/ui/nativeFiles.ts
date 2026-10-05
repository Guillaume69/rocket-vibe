import {createHash} from 'crypto';
import {fetch as expoFetch} from 'expo/fetch';
import {File} from 'expo-file-system';
import * as FS from 'expo-file-system/legacy';
import {FileTransfer} from '../modules/file-transfer/index.ts';
import {FILE_MAX} from '../providers/rocketvibe/fileDescriptors.ts';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import type {NativeFileIO} from '../providers/rocketvibe/uploads.ts';
import type {Provider} from '../lib/provider.ts';
import type {RestClient} from '../lib/rest.ts';
import {setNativeFiles} from '../lib/nativeFiles.ts';
import {safeFileName,withExtension} from '../lib/attachment.ts';
import {copyVerifiedFile} from '../lib/streamingFile.ts';

async function hashFile(uri:string):Promise<{bytes:number;sha256:string}>{
  const reader=new File(uri).readableStream().getReader(),hash=createHash('sha256');let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>FILE_MAX)throw new NativeError(413,'file_too_large');hash.update(next.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(bytes===0)throw new NativeError(422,'invalid_file');return {bytes,sha256:hash.digest('hex')};
}
export async function createNativeFilesIO(provider:Provider):Promise<NativeFileIO>{
  if(!FS.documentDirectory||!provider.native)throw new NativeError(422,'local_file_unavailable');
  const identity=provider.identity,account=createHash('sha256').update(JSON.stringify([identity.origin,identity.accountId,identity.instanceId])).digest('hex');
  const epoch=createHash('sha256').update(identity.generation??'').digest('hex');
  const accountRoot=`${FS.documentDirectory}native-outbox/${account}/`,root=`${accountRoot}${epoch}/`;
  await FS.makeDirectoryAsync(root,{intermediates:true});
  const kept=new Set((await provider.native.store.uploads.list()).map(intent=>intent.uri));
  for(const folder of await FS.readDirectoryAsync(accountRoot))if(folder!==epoch&&/^[a-f0-9]{64}$/.test(folder))await FS.deleteAsync(`${accountRoot}${folder}/`,{idempotent:true});
  for(const name of await FS.readDirectoryAsync(root))if(!kept.has(root+name))await FS.deleteAsync(root+name,{idempotent:true});
  return {
  available:FileTransfer!==null,
  copy:async(file,id)=>{
    const uri=`${root}${id}`;
    await FS.makeDirectoryAsync(root,{intermediates:true});
    try{await FS.copyAsync({from:file.uri,to:uri});return {uri,...await hashFile(uri)};}
    catch(error){await FS.deleteAsync(uri,{idempotent:true}).catch(()=>{});throw error instanceof NativeError?error:new NativeError(422,'local_file_unavailable');}
  },
  remove:async(uri)=>{
    if(uri.startsWith(root))await FS.deleteAsync(uri,{idempotent:true});
  },
  send:async(url,headers,uri,signal,progress)=>{
    if(!FileTransfer)throw new NativeError(501,'file_transfer_module_unavailable');
    if(!(await FS.getInfoAsync(uri)).exists)throw new NativeError(422,'local_file_unavailable');
    if(signal.aborted)throw new NativeError(0,'session_closed');
    const id=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const listener=FileTransfer.addListener('progress',event=>{if(event.id===id)progress(Math.max(0,Math.min(1,event.fraction)));});
    const abort=()=>{void FileTransfer!.cancel(id).catch(()=>{});};signal.addEventListener('abort',abort);
    try{return await FileTransfer.upload(id,url,uri,headers);}
    catch{throw new NativeError(0,'file_transfer_interrupted');}
    finally{signal.removeEventListener('abort',abort);listener.remove();}
  },
  };
}

let cacheMaintenance:Promise<void>=Promise.resolve();

/** Each provider owns a private directory. A revoked generation discards it. */
export function mountNativeFiles(client:RestClient,provider:Provider):()=>void {
  const chat=provider.native?.chat;if(!chat||!FS.cacheDirectory)return()=>{};
  const root=`${FS.cacheDirectory}native-files/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  const parent=`${FS.cacheDirectory}native-files/`;
  const ready=cacheMaintenance.then(async()=>{
    await FS.makeDirectoryAsync(parent,{intermediates:true});
    for(const name of await FS.readDirectoryAsync(parent))if(parent+name+'/'!==root&&/^[0-9]+-[a-z0-9]+$/.test(name))await FS.deleteAsync(parent+name+'/',{idempotent:true});
  });cacheMaintenance=ready.catch(()=>{});
  let active=true,version=chat.searchVersion,revision=0;
  let running=0;const waiters:(()=>void)[]=[];
  const acquire=async()=>{if(!active)throw new NativeError(0,'session_closed');if(running<4){running++;return;}await new Promise<void>(resolve=>waiters.push(resolve));if(!active)throw new NativeError(0,'session_closed');};
  const release=()=>{const next=waiters.shift();if(next)next();else running--;};
  const transfers=new Map<string,Promise<string>>(),controllers=new Set<AbortController>();
  const unregistry=setNativeFiles(client,async(id,progress)=>{
    const existing=transfers.get(id);if(existing)return existing;
    const operation=(async()=>{
      await ready;await acquire();
      try{
      const access=await chat.store.fileAccess(id);if(!access)throw new NativeError(403,'file_access_denied');
      const scope=await chat.fileScope(access.file.room_id,access.membership),stamp=revision;
      const check=async()=>{
        if(!active||revision!==stamp||!scope.alive())throw new NativeError(0,'session_closed');
        const current=await chat.store.fileAccess(id);
        if(!current||current.membership!==access.membership||current.file.sha256!==access.file.sha256)throw new NativeError(403,'file_access_denied');
      };
      const dir=`${root}${stamp}/${id}/`,destination=`${dir}${encodeURIComponent(withExtension(safeFileName(access.file.filename),access.file.media_type))}`;
      const part=`${destination}.${stamp}.part`,controller=new AbortController();controllers.add(controller);
      await FS.makeDirectoryAsync(dir,{intermediates:true});
      try{
        if((await FS.getInfoAsync(destination)).exists){
          await chat.transport.downloadFile(access.file,expoFetch as typeof fetch,async response=>{if((await response.arrayBuffer()).byteLength!==1)throw new NativeError(502,'invalid_file');},controller.signal,true);
          await scope.check();await check();return destination;
        }
        // Revalidate remotely on every new reader, including an already cached file.
        await chat.transport.downloadFile(access.file,expoFetch as typeof fetch,async response=>{
          if(!response.body)throw new NativeError(502,'invalid_file');
          const file=new File(part);file.create({overwrite:true});
          await copyVerifiedFile({body:response.body,writer:file.writableStream().getWriter(),bytes:Number(access.file.bytes),sha256:access.file.sha256,
            alive:()=>active&&revision===stamp&&scope.alive(),progress});
        },controller.signal);
        await scope.check();await check();
        await FS.deleteAsync(destination,{idempotent:true});await FS.moveAsync({from:part,to:destination});
        await check();return destination;
      }catch(error){await FS.deleteAsync(part,{idempotent:true}).catch(()=>{});await FS.deleteAsync(destination,{idempotent:true}).catch(()=>{});throw error;}
      finally{controllers.delete(controller);}
      }finally{release();}
    })().finally(()=>{if(transfers.get(id)===operation)transfers.delete(id);});
    transfers.set(id,operation);return operation;
  },fn=>{
    let observed=`${chat.searchVersion}:${chat.filesActive}`;
    return chat.subscribe(()=>{const next=`${chat.searchVersion}:${chat.filesActive}`;if(observed!==next){observed=next;fn();}});
  },()=>revision);
  const invalidate=()=>{const old=revision++;for(const c of controllers)c.abort();transfers.clear();void FS.deleteAsync(`${root}${old}/`,{idempotent:true}).catch(()=>{});};
  const unlisten=chat.subscribe(()=>{if(version!==chat.searchVersion){version=chat.searchVersion;invalidate();}});
  return()=>{active=false;for(const next of waiters.splice(0))next();unlisten();unregistry();invalidate();void FS.deleteAsync(root,{idempotent:true}).catch(()=>{});};
}
