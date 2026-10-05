import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {AppState} from 'react-native';
import {CryptoNative} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {CryptoConversationAccess,CryptoConversationView} from '../providers/rocketvibe/cryptoConversations.ts';
import type {Outbox} from '../lib/provider.ts';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {refreshNativeReply,invalidateNativeReply,readReply,useReply} from './reply.ts';
/** The existing room list consumes a volatile native projection. Blur,
 * suspension and membership changes dispose it; no lissage retains clear rows. */
export function useEncryptedConversation(chat:NativeChat|undefined,room:string,membership:string|null|undefined,enabled:boolean,thread:string|null=null) {
  const replyKey=thread===null?room:`${room}:${thread}`,response=useReply(replyKey);
  const [view,setView]=useState<CryptoConversationView|null>(null),[failed,setFailed]=useState(false);
  const [busy,setBusy]=useState(false),[composer,setComposer]=useState(0);
  const [initial,setInitial]=useState<string|null>(null);
  const focused=useRef(false),epoch=useRef(0),access=useRef<CryptoConversationAccess|null>(null),job=useRef<number|null>(null);
  const opening=useRef<Promise<CryptoConversationAccess>|null>(null),lastInitial=useRef<number|null>(null);
  const clear=useCallback(()=>{epoch.current++;job.current=null;opening.current=null;lastInitial.current=null;
    const target=readReply(replyKey);if(target?.native)invalidateNativeReply(replyKey,target);
    void access.current?.close();access.current=null;setView(null);setInitial(null);setBusy(false);},[replyKey]);
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
      const pending=(view?.messages??[]).filter(row=>row.status==='pending' || row.status==='cancelling');
      await run(async a=>{for(const row of pending)await a.resume(row.operation);});
    },
    retry:async id=>{const row=view?.messages.find(v=>v.id===id);if(!row)throw Error('Private intention unavailable');
      await run(a=>row.status==='cancelled'?a.restore(row.operation):a.resume(row.operation),row.status==='cancelled');},
    discard:async id=>{const row=view?.messages.find(v=>v.id===id);if(!row)throw Error('Private intention unavailable');await run(a=>a.cancel(row.operation));},
  }),[room,thread,run,view]);
  return {view,initial,composer,failed,busy,outbox,save,reload};
}
