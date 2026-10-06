import {useCallback,useEffect,useRef,useState} from 'react';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {UserPreferences} from '../providers/rocketvibe/protocol.generated.ts';
import type {SavedProfileOperation} from '../providers/rocketvibe/profileOperations.ts';

/** Keep the original revision while editing; an uncertain write remains recoverable. */
export function useNativePreferences(chat:NativeChat|null|undefined,generation:number) {
  const [preferences,setPreferences]=useState<UserPreferences|null>(null);
  const [intention,setIntention]=useState<SavedProfileOperation|null>(null);
  const [error,setError]=useState(false);
  const [busy,setBusy]=useState(false);
  const [owner,setOwner]=useState<NativeChat|null|undefined>(null);
  const inFlight=useRef(false),current=useRef(chat),pending=useRef<SavedProfileOperation|null>(null);
  useEffect(()=>{current.current=chat;pending.current=null;return()=>{current.current=null;};},[chat]);
  const online=chat?.status.online===true;
  useEffect(()=>{
    let alive=true;
    if(chat&&online&&chat.capabilities?.profiles)void Promise.all([chat.ownProfile(),chat.store.profileOperations.get('preferences')]).then(([own,saved])=>{
      if(!alive)return;setOwner(chat);setPreferences(own.preferences);setIntention(saved);setError(false);pending.current=saved;
    }).catch(()=>{if(alive){setOwner(chat);setError(true);}});
    return()=>{alive=false;};
  },[chat,online]);
  useEffect(()=>{
    let alive=true;
    if(chat&&online)void chat.store.profileOperations.get('preferences').then(async saved=>{
      if(!alive)return;
      const confirmed=pending.current!==null&&saved===null;
      pending.current=saved;setIntention(saved);
      if(confirmed){const own=await chat.ownProfile();if(alive){setPreferences(own.preferences);setError(false);}}
    }).catch(()=>{if(alive)setError(true);});
    return()=>{alive=false;};
  },[chat,online,generation]);
  const act=useCallback(async(changes:Partial<Omit<UserPreferences,'revision'>>|null,abandon=false)=>{
    if(!chat||owner!==chat||!preferences||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(false);
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
      setError(true);const saved=await chat.store.profileOperations.get('preferences').catch(()=>null);
      if(current.current===chat){pending.current=saved;setIntention(saved);}
    }finally{inFlight.current=false;if(current.current===chat)setBusy(false);}
  },[chat,owner,preferences]);
  const wanted=owner!==chat?null:intention?.command.kind==='preferences'?{...preferences,...intention.command.input,revision:intention.command.input.expected_revision}:preferences;
  return {preferences:wanted,intention:owner===chat?intention:null,error:owner===chat&&error,busy:owner===chat&&busy,change:(changes:Partial<Omit<UserPreferences,'revision'>>)=>act(changes),resume:()=>act(null),discard:()=>act(null,true)};
}
