import {useCallback,useEffect,useRef,useState} from 'react';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {UserPreferences} from '../fournisseurs/rocketvibe/protocol.generated.ts';
import type {SavedProfileOperation} from '../fournisseurs/rocketvibe/profileOperations.ts';

/** Keep the original revision while editing; an uncertain write remains recoverable. */
export function usePreferencesNatives(chat:NativeChat|null|undefined,generation:number) {
  const [preferences,setPreferences]=useState<UserPreferences|null>(null);
  const [intention,setIntention]=useState<SavedProfileOperation|null>(null);
  const [erreur,setErreur]=useState(false);
  const [occupe,setOccupe]=useState(false);
  const [owner,setOwner]=useState<NativeChat|null|undefined>(null);
  const enVol=useRef(false),current=useRef(chat),pending=useRef<SavedProfileOperation|null>(null);
  useEffect(()=>{current.current=chat;pending.current=null;return()=>{current.current=null;};},[chat]);
  const online=chat?.status.online===true;
  useEffect(()=>{
    let vivant=true;
    if(chat&&online&&chat.capabilities?.profiles)void Promise.all([chat.ownProfile(),chat.store.profileOperations.get('preferences')]).then(([own,saved])=>{
      if(!vivant)return;setOwner(chat);setPreferences(own.preferences);setIntention(saved);setErreur(false);pending.current=saved;
    }).catch(()=>{if(vivant){setOwner(chat);setErreur(true);}});
    return()=>{vivant=false;};
  },[chat,online]);
  useEffect(()=>{
    let vivant=true;
    if(chat&&online)void chat.store.profileOperations.get('preferences').then(async saved=>{
      if(!vivant)return;
      const confirmed=pending.current!==null&&saved===null;
      pending.current=saved;setIntention(saved);
      if(confirmed){const own=await chat.ownProfile();if(vivant){setPreferences(own.preferences);setErreur(false);}}
    }).catch(()=>{if(vivant)setErreur(true);});
    return()=>{vivant=false;};
  },[chat,online,generation]);
  const agir=useCallback(async(changes:Partial<Omit<UserPreferences,'revision'>>|null,abandon=false)=>{
    if(!chat||owner!==chat||!preferences||enVol.current)return;
    enVol.current=true;setOccupe(true);setErreur(false);
    try{
      if(abandon){
        const saved=await chat.store.profileOperations.get('preferences');
        if(!saved||!await chat.discardProfile('preferences',saved.command.input.operation_id))return;
      }
      const own=abandon?await chat.ownProfile():changes?await chat.updateOwnPreferences(preferences,changes):await chat.resumeProfile('preferences');
      if(current.current!==chat)return;
      pending.current=null;setIntention(null);setPreferences(own.preferences);
    }catch{
      if(current.current!==chat)return;
      setErreur(true);const saved=await chat.store.profileOperations.get('preferences').catch(()=>null);
      if(current.current===chat){pending.current=saved;setIntention(saved);}
    }finally{enVol.current=false;if(current.current===chat)setOccupe(false);}
  },[chat,owner,preferences]);
  const desirees=owner!==chat?null:intention?.command.kind==='preferences'?{...preferences,...intention.command.input,revision:intention.command.input.expected_revision}:preferences;
  return {preferences:desirees,intention:owner===chat?intention:null,erreur:owner===chat&&erreur,occupe:owner===chat&&occupe,changer:(changes:Partial<Omit<UserPreferences,'revision'>>)=>agir(changes),reprendre:()=>agir(null),abandonner:()=>agir(null,true)};
}
