import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {AppState} from 'react-native';
import {CryptoNative} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {CryptoConversationAccess,CryptoConversationView,CryptoMessage} from '../providers/rocketvibe/cryptoConversations.ts';
import type {FileOutbox,Outbox} from '../lib/provider.ts';
import * as FS from 'expo-file-system/legacy';
import {ValidationError} from '../lib/uploadQueue.ts';
import {PRIVATE_FILE_MAX,sendPrivateFile} from '../providers/rocketvibe/privateFiles.ts';
import {nativeFileSender} from './nativeFiles.ts';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {refreshNativeReply,invalidateNativeReply,readReply,useReply} from './reply.ts';
/** A projected row, thread root included. */
export function privateRow(view:CryptoConversationView|null,id:string):CryptoMessage|undefined {
  return view?.root?.id===id?view.root:view?.messages.find(row=>row.id===id);
}
/** A send or an amendment of this row waits for the server. */
export function privateInterrupted(row:CryptoMessage|undefined):boolean {
  return !!row && (['pending','cancelling','cancelled'].includes(row.status) || !!row.amendment);
}
/** The existing room list consumes a volatile native projection. Blur,
 * suspension and membership changes dispose it; no lissage retains clear rows. */
export function useEncryptedConversation(chat:NativeChat|undefined,room:string,membership:string|null|undefined,enabled:boolean,thread:string|null=null) {
  const replyKey=thread===null?room:`${room}:${thread}`,response=useReply(replyKey);
  const [view,setView]=useState<CryptoConversationView|null>(null),[failed,setFailed]=useState(false);
  const [busy,setBusy]=useState(false),[composer,setComposer]=useState(0);
  const [initial,setInitial]=useState<string|null>(null);
  const focused=useRef(false),epoch=useRef(0),access=useRef<CryptoConversationAccess|null>(null),job=useRef<number|null>(null);
  const opening=useRef<Promise<CryptoConversationAccess>|null>(null),lastInitial=useRef<number|null>(null);
  // This view's token for the encrypted files it makes openable (E2EE_FILES.md).
  const token=useRef(Math.floor(Math.random()*2**52));
  const clear=useCallback(()=>{epoch.current++;job.current=null;opening.current=null;lastInitial.current=null;
    chat?.forgetPrivateFiles(token.current);
    const target=readReply(replyKey);if(target?.native)invalidateNativeReply(replyKey,target);
    void access.current?.close();access.current=null;setView(null);setInitial(null);setBusy(false);},[replyKey,chat]);
  const run=useCallback(async<T,>(action:(a:CryptoConversationAccess)=>Promise<T>,restore=false,retainPrepared=false):Promise<T>=>{
    if(!enabled || !chat || membership==null || !focused.current || AppState.currentState!=='active' || !CryptoNative)throw Error('Private conversation unavailable');
    const n=epoch.current,visible=()=>epoch.current===n && focused.current && AppState.currentState==='active';
    setBusy(true);setFailed(false);
    let completed=false,result:T|undefined;
    try {
      if(!access.current) {
        opening.current??=chat.cryptoConversation(CryptoNative,room,membership,visible,thread);
        const a=await opening.current;
        if(!visible()){void a.close();throw Error('Private conversation closed');}access.current=a;
      }
      const a=access.current;result=await action(a);completed=true;
      if(!visible())throw Error('Private conversation closed');
      let current=await a.refresh();
      // A page checkpoint precedes the next request. Bound each UI run; another
      // refresh resumes the durable cursor without reopening an MLS ratchet.
      for(let p=0;p<8 && current.catching_up;p++)current=await a.refresh();
      const target=readReply(replyKey);
      if(target?.native) {
        const preview=await a.previewQuote(target.native);
        if(visible()) {
          if(preview)refreshNativeReply(replyKey,target,preview);
          else invalidateNativeReply(replyKey,target);
        }
      }
      // New verified messages may be waiting for the history backup.
      if(visible() && CryptoNative)chat.syncHistoryBackupSoon(CryptoNative);
      if(visible()) {
        chat.forgetPrivateFiles(token.current);
        chat.registerPrivateFiles(token.current,room,[...(current.root?[current.root]:[]),...current.messages].flatMap(m=>m.document.files??[]));
        setView(current);
        if(lastInitial.current!==n || restore){lastInitial.current=n;setInitial(current.draft);setComposer(v=>v+1);}
      }
      return result;
    } catch(error) {
      if(retainPrepared && completed && visible() && error instanceof NativeError
        && (['network_error','network_or_protocol_error'].includes(error.code) || error.status>=500 || error.status===429)) {
        setFailed(true);return result as T;
      }
      if(visible()){clear();setFailed(true);}throw error;
    } finally {if(visible())setBusy(false);}
  },[chat,room,membership,enabled,thread,clear,replyKey]);
  const reload=useCallback(()=>{
    if(job.current!==null || !enabled)return;
    const n=epoch.current;job.current=n;
    void run(async()=>{}).catch(()=>{}).finally(()=>{if(job.current===n)job.current=null;});
  },[run,enabled]);
  useEffect(()=>{if(enabled && focused.current && response?.native)reload();},[enabled,response?.native,reload]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();if(enabled)reload();return()=>{focused.current=false;clear();};},[clear,enabled,reload]));
  useEffect(()=>{const sub=AppState.addEventListener('change',state=>{if(state!=='active')clear();else if(focused.current)reload();});return()=>sub.remove();},[clear,reload]);
  useEffect(()=>{if(!enabled || !chat)return;
    let online=chat.status.online;
    const unsubscribe=chat.subscribe(()=>{
      if(access.current?.isClosed)clear();
      const next=chat.status.online;
      if(next && !online && focused.current)reload();
      online=next;
    });
    const timer=setInterval(()=>{if(focused.current && AppState.currentState==='active' && chat.status.online)reload();},10000);
    return()=>{clearInterval(timer);unsubscribe();};
  },[enabled,chat,reload,clear]);
  const save=useCallback((text:string)=>{
    if(!focused.current || AppState.currentState!=='active')return;
    void access.current?.saveDraft(text).catch(()=>{if(focused.current){clear();setFailed(true);}});
  },[clear]);
  const outbox=useMemo<Outbox>(()=>({
    send:async(target,text,replyTo,_attachments,quotes=[])=>{
      if(target!==room || (replyTo??null)!==thread || _attachments)throw Error('Private document unavailable');
      return run(a=>a.send(text,quotes),false,true);
    },
    process:async()=>{
      const rows=[...(view?.root?[view.root]:[]),...(view?.messages??[])];
      const pending=[...rows.filter(row=>row.status==='pending' || row.status==='cancelling').map(row=>row.operation),
        ...rows.flatMap(row=>row.amendment?[row.amendment.operation]:[])];
      await run(async a=>{for(const operation of pending)await a.resume(operation);});
    },
    retry:async id=>{const row=privateRow(view,id);if(!row)throw Error('Private intention unavailable');
      if(row.amendment){const operation=row.amendment.operation;await run(a=>a.resume(operation));return;}
      await run(a=>row.status==='cancelled'?a.restore(row.operation):a.resume(row.operation),row.status==='cancelled');},
    discard:async id=>{const row=privateRow(view,id);if(!row)throw Error('Private intention unavailable');
      const operation=row.amendment?.operation??row.operation;await run(a=>a.cancel(operation));},
  }),[room,thread,run,view]);
  // Encrypted files: sealed in Rust beside the app's cache, uploaded opaque,
  // then sent in a private message of the room itself (E2EE_FILES.md).
  const progress=useRef(new Map<string,number>()),listeners=useRef(new Set<()=>void>());
  const files=useMemo<FileOutbox|null>(()=>{
    if(!chat || thread!==null || !CryptoNative?.sealFile || !FS.cacheDirectory)return null;
    const crypto=CryptoNative,folder=`${FS.cacheDirectory}private-outbox/`;
    const notify=()=>{for(const l of listeners.current)l();};
    return {
      progress:progress.current,
      subscribe:listener=>{listeners.current.add(listener);return()=>{listeners.current.delete(listener);};},
      validate:async file=>{if(file.size!==null && file.size>PRIVATE_FILE_MAX)throw new ValidationError({code:'size',maxMb:'100.0'});},
      send:async(target,file,caption)=>{
        if(target!==room)throw Error('Private document unavailable');
        if(file.size!==null && file.size>PRIVATE_FILE_MAX)throw new ValidationError({code:'size',maxMb:'100.0'});
        const id=`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,object=`${folder}${id}`;
        await FS.makeDirectoryAsync(folder,{intermediates:true});
        const controller=new AbortController();
        try {
          await run(a=>sendPrivateFile({crypto,transport:chat.transport,send:nativeFileSender,access:a,room,
            file:{uri:file.uri,name:file.name,type:file.type},caption:caption??'',object,operation:id,
            progress:fraction=>{progress.current.set(id,fraction);notify();},signal:controller.signal}),false,true);
        } finally {
          progress.current.delete(id);notify();
          await FS.deleteAsync(object,{idempotent:true}).catch(()=>{});
        }
      },
      process:async()=>{},retry:async()=>{},discard:async()=>{},
    };
  },[chat,room,thread,run]);
  /** An encrypted reaction or its withdrawal, delivered like a send. */
  const react=useCallback((id:string,code:string,present:boolean)=>{
    void run(a=>a.react(id,code,present),false,true).catch(()=>{});
  },[run]);
  return {view,initial,composer,failed,busy,outbox,save,reload,react,files};
}
