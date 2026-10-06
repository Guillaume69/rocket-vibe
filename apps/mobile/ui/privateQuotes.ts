import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {AppState} from 'react-native';
import {CryptoNative} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {NativeQuoteAttachment,NativeQuoteSelection} from '../providers/rocketvibe/quotes.ts';
import {quoteRows,overlayQuoteRows,type CryptoQuoteReader} from '../providers/rocketvibe/cryptoQuoteReader.ts';
import {refreshPrivateReply,invalidateNativeReply,readReply,useReply} from './reply.ts';

/** Only the final render gets decrypted quote cards. The ordinary cache,
 * smoothing buffer, action sheet and route parameters keep references only. */
export function usePrivateQuotes<T extends {id:string;attachments:string|null}>(chat:NativeChat|undefined,
  room:string,membership:string|null|undefined,enabled:boolean,rows:T[],thread:string|null=null) {
  const key=thread===null?room:`${room}:${thread}`,response=useReply(key);
  const refs=useMemo(()=>enabled?quoteRows(rows):[],[enabled,rows]),latest=useRef(refs);latest.current=refs;
  const [projection,setProjection]=useState<{refs:typeof refs;cards:Record<string,NativeQuoteAttachment[]>}|null>(null);
  const reader=useRef<CryptoQuoteReader|null>(null),epoch=useRef(0),focused=useRef(false),pending=useRef<number|null>(null);
  const clear=useCallback(()=>{epoch.current++;pending.current=null;
    const target=readReply(key);if(target?.native?.crypto_admission)invalidateNativeReply(key,target);
    void reader.current?.close();reader.current=null;setProjection(null);},[key]);
  const reload=useCallback(():void=>{
    if(!enabled || !chat || membership==null || !CryptoNative || !focused.current || AppState.currentState!=='active' || pending.current!==null)return;
    const n=epoch.current;pending.current=n;
    const visible=()=>epoch.current===n && focused.current && AppState.currentState==='active';
    const requested=latest.current,selected=readReply(key);
    void (async()=>{
      if(!reader.current) {
        const opened=await chat.cryptoQuoteReader(CryptoNative,room,membership,visible);
        if(!visible()){await opened.close();return;}reader.current=opened;
      }
      const value=await reader.current.project(requested);
      if(selected?.native?.crypto_admission) {
        const preview=await reader.current.previewQuote(selected.native);
        if(visible()) {
          if(preview)refreshPrivateReply(key,selected,preview);
          else invalidateNativeReply(key,selected);
        }
      }
      if(visible() && latest.current===requested)setProjection({refs:requested,cards:value});
    })().catch(()=>{if(visible())clear();}).finally(()=>{
      if(pending.current!==n)return;pending.current=null;
      if(visible() && (latest.current!==requested || readReply(key)?.native!==selected?.native))reload();
    });
  },[enabled,chat,room,membership,clear,key]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();reload();return()=>{focused.current=false;clear();};},[clear,reload]));
  useEffect(()=>{if(!enabled)return;setProjection(null);reload();},[enabled,refs,reload]);
  useEffect(()=>{if(enabled && response?.native?.crypto_admission)reload();},[enabled,response?.native,reload]);
  useEffect(()=>{const sub=AppState.addEventListener('change',s=>{if(s!=='active')clear();else if(focused.current)reload();});return()=>sub.remove();},[clear,reload]);
  useEffect(()=>{if(!enabled || !chat)return;
    const unsubscribe=chat.subscribe(()=>{clear();if(focused.current)reload();});
    const timer=setInterval(()=>{if(focused.current)reload();},10000);
    return()=>{unsubscribe();clearInterval(timer);};
  },[enabled,chat,clear,reload]);
  const send=useCallback(async(text:string,quotes:readonly NativeQuoteSelection[]=[])=>{
    if(!chat || membership==null)throw Error('Quote destination unavailable');
    if(!quotes.some(q=>q.crypto_admission!==undefined))return chat.send(room,text,{membership},quotes,thread);
    const n=epoch.current,visible=()=>enabled && focused.current && epoch.current===n && AppState.currentState==='active';
    if(!CryptoNative || !visible())throw Error('Private quote reader unavailable');
    return chat.sendQuoted(CryptoNative,room,text,{membership},quotes,thread,visible);
  },[chat,room,membership,thread,enabled]);
  const rendered=useMemo(()=>enabled && projection?.refs===refs?overlayQuoteRows(rows,projection.cards):rows,[enabled,rows,projection,refs]);
  return {rows:rendered,send};
}
