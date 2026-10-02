/** A confirmed preference and its original pending request in the existing sheet. */
import {eq} from 'drizzle-orm';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Text,View} from 'react-native';
import type {BaseLocale} from '../db/client.ts';
import {nativeReadStates,nativeFavoriteIntents} from '../db/schema.ts';
import type {EtatFavoriSalon,FavoriSalon} from '../lib/fournisseur.ts';
import {useRequeteVive} from './requeteVive.ts';
import {useT} from './i18n.ts';
import type {Couleurs} from './theme.ts';

export function FavoriSalonNatif({rid,adhesion,base,actions,c,bouton}:{rid:string;adhesion:string;base:BaseLocale;actions:FavoriSalon;c:Couleurs;bouton:(label:string,action:()=>void,disabled:boolean)=>ReactNode}) {
  const t=useT(),alive=useRef(true);
  const {data:personal}=useRequeteVive(base.select().from(nativeReadStates).where(eq(nativeReadStates.rid,rid)),[rid]);
  const {data:queue}=useRequeteVive(base.select().from(nativeFavoriteIntents).where(eq(nativeFavoriteIntents.rid,rid)),[rid]);
  const [state,setState]=useState<EtatFavoriSalon|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const version=JSON.stringify([personal[0]?.payload,queue[0]?.id,queue[0]?.phase,queue[0]?.error]);
  useEffect(()=>{
    let current=true;
    void actions.lire?.(rid).then(value=>{if(current)setState(value?.adhesion===adhesion?value:null);}).catch(()=>{if(current)setError(true);});
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
    {bouton(state.present?'★ '+t('salonInfo.retirerFavori'):'☆ '+t('salonInfo.ajouterFavori'),()=>void run(()=>actions.modifier(rid,!state.present,state)),busy||saved!==null)}
    {saved && <>
      <Text style={{color:saved.echouee?c.texteErreur:c.attenue}}>{t(saved.echouee?'gestionSalon.refus':'gestionSalon.attente')}</Text>
      {saved.echouee && actions.effacer?bouton(t('gestionSalon.effacer'),()=>void run(()=>actions.effacer!(rid,saved.cle)),busy):actions.reprendre?bouton(t('gestionSalon.reprendre'),()=>void run(()=>actions.reprendre!(rid,saved.cle)),busy):null}
    </>}
    {error && <Text accessibilityRole="alert" style={{color:c.texteErreur}}>{t('salonInfo.favoriEchec')}</Text>}
  </View>;
}
