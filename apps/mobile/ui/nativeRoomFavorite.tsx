/** A confirmed preference and its original pending request in the existing sheet. */
import {eq} from 'drizzle-orm';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Text,View} from 'react-native';
import type {LocalDatabase} from '../db/client.ts';
import {nativeReadStates,nativeFavoriteIntents} from '../db/schema.ts';
import type {RoomFavoriteState,RoomFavorite} from '../lib/provider.ts';
import {useCoalescedLiveQuery} from './liveQuery.ts';
import {useT} from './i18n.ts';
import type {Colors} from './theme.ts';

export function NativeRoomFavorite({rid,adhesion,base,actions,c,button}:{rid:string;adhesion:string;base:LocalDatabase;actions:RoomFavorite;c:Colors;button:(label:string,action:()=>void,disabled:boolean)=>ReactNode}) {
  const t=useT(),alive=useRef(true);
  const {data:personal}=useCoalescedLiveQuery(base.select().from(nativeReadStates).where(eq(nativeReadStates.rid,rid)),[rid]);
  const {data:queue}=useCoalescedLiveQuery(base.select().from(nativeFavoriteIntents).where(eq(nativeFavoriteIntents.rid,rid)),[rid]);
  const [state,setState]=useState<RoomFavoriteState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const version=JSON.stringify([personal[0]?.payload,queue[0]?.id,queue[0]?.phase,queue[0]?.error]);
  useEffect(()=>{
    let current=true;
    void actions.read?.(rid).then(value=>{if(current)setState(value?.adhesion===adhesion?value:null);}).catch(()=>{if(current)setError(true);});
    return()=>{current=false;};
  },[actions,rid,adhesion,version,refresh]);
  const run=async(action:()=>Promise<unknown>)=>{
    if(!alive.current || busy)return;
    setBusy(true);setError(false);
    try{await action();}catch{if(alive.current)setError(true);}
    finally{if(alive.current){setBusy(false);setRefresh(value=>value+1);}}
  };
  if(!state)return null;
  const saved=state.intention;
  return <View style={{gap:10}}>
    {button(state.present?'★ '+t('roomInfo.removeFavorite'):'☆ '+t('roomInfo.addFavorite'),()=>void run(()=>actions.edit(rid,!state.present,state)),busy||saved!==null)}
    {saved && <>
      <Text style={{color:saved.failed?c.errorText:c.dimmed}}>{t(saved.failed?'roomManagement.rejected':'roomManagement.pending')}</Text>
      {saved.failed && actions.clear?button(t('roomManagement.clear'),()=>void run(()=>actions.clear!(rid,saved.key)),busy):actions.resume?button(t('roomManagement.resume'),()=>void run(()=>actions.resume!(rid,saved.key)),busy):null}
    </>}
    {error && <Text accessibilityRole="alert" style={{color:c.errorText}}>{t('roomInfo.favoriteFailed')}</Text>}
  </View>;
}
