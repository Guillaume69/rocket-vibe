import {useCallback,useEffect,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import {dismissible} from './alerts.ts';
import {CryptoNative,type CryptoGroupPreview} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {CryptoGroupAccess,CryptoGroupView} from '../providers/rocketvibe/cryptoGroups.ts';
import {useSync} from './sync.tsx';
import {useT} from './i18n.ts';
import {Tappable} from './tappable.tsx';
import {FONTS,type Colors} from './theme.ts';
import type {TranslationKey} from './messages.ts';

function Action({c,label,onPress,disabled}:{c:Colors;label:string;onPress:()=>void;disabled:boolean}) {
  return <Tappable disabled={disabled} accessibilityRole="button" onPress={onPress}>
    <Text style={[styles.action,{color:c.cyan}]}>{label}</Text></Tappable>;
}
export function EncryptedGroupSection({c,room,membership}:{c:Colors;room:string;membership:string}) {
  const sync=useSync(),chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  return CryptoNative && chat?.capabilities?.e2ee && chat.capabilities.device_sessions
    ? <Group key={`${JSON.stringify(sync.phase==='ready'?sync.provider.identity:null)}:${room}:${membership}`} c={c} room={room} membership={membership} chat={chat}/> : null;
}
const kinds:Record<CryptoGroupPreview['kind'],TranslationKey>={genesis:'group.create',change:'group.change',admission:'group.join',readmission:'group.rejoin',commit:'group.receive'};
function Group({c,room,membership,chat}:{c:Colors;room:string;membership:string;chat:NativeChat}) {
  const t=useT(),[expanded,setExpanded]=useState(false),[view,setView]=useState<CryptoGroupView|null>(null);
  const [preview,setPreview]=useState<CryptoGroupPreview|null>(null),[selected,setSelected]=useState<string[]>([]),[removals,setRemovals]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState<false|'untrusted'|true>(false);
  const focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null),access=useRef<CryptoGroupAccess|null>(null);
  // Members are reviewed by name, not by account id; the id stays the fallback.
  const [names,setNames]=useState<Record<string,string>>({});
  useEffect(()=>{
    if(!expanded)return;
    let live=true;
    void (async()=>{
      const found:Record<string,string>={};
      let after:string|undefined;
      for(let page=0;page<8;page++){
        const members=await chat.roomMembers(room,after);
        for(const m of members.members)found[m.user.id]=m.user.display_name||m.user.username;
        if(!members.next)break;
        after=members.next;
      }
      if(live)setNames(found);
    })().catch(()=>{});
    return()=>{live=false;};
  },[chat,room,expanded]);
  const who=(user:string)=>names[user]??user;
  const clear=useCallback(()=>{epoch.current++;job.current=null;void access.current?.close();access.current=null;
    setView(null);setPreview(null);setSelected([]);setRemovals([]);setBusy(false);setFailed(false);},[]);
  const run=useCallback(async(action:(a:CryptoGroupAccess,visible:()=>boolean)=>Promise<CryptoGroupView|void>)=>{
    if(!focused.current || !expanded || job.current!==null || AppState.currentState!=='active' || !CryptoNative)return;
    const n=epoch.current,visible=()=>focused.current && epoch.current===n && AppState.currentState==='active';
    job.current=n;setBusy(true);setFailed(false);
    try {
      const a=access.current??await chat.cryptoGroup(CryptoNative,room,membership,visible);
      if(!visible()){void a.close();return;}access.current=a;
      const result=await action(a,visible);if(visible() && result)setView(result);
    } catch(error) {if(visible()){setFailed(String(error).includes('CryptoBridgeException$Untrusted')?'untrusted':true);setView(null);setPreview(null);setSelected([]);setRemovals([]);}}
    finally {if(job.current===n){job.current=null;if(visible())setBusy(false);}}
  },[chat,room,membership,expanded]);
  const reload=useCallback(()=>{setPreview(null);setSelected([]);setRemovals([]);void run(a=>a.read());},[run]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();if(expanded)reload();return()=>{focused.current=false;clear();};},[clear,expanded,reload]));
  useEffect(()=>{const sub=AppState.addEventListener('change',state=>{if(state!=='active')clear();else if(focused.current && expanded)reload();});return()=>sub.remove();},[clear,expanded,reload]);
  const toggle=(device:string,remove=false)=>{
    if(remove) {
      const enabled=!removals.includes(device);
      setRemovals(enabled?[...removals,device]:removals.filter(d=>d!==device));
      if(!enabled)setSelected(selected.filter(d=>d!==device));
    } else {
      const enabled=!selected.includes(device);
      setSelected(enabled?[...selected,device]:selected.filter(d=>d!==device));
      if(view?.eligible.find(d=>d.device===device)?.replacement)
        setRemovals(enabled?[...new Set([...removals,device])]:removals.filter(d=>d!==device));
    }
  };
  const prepare=(receive=false)=>{const current=view;if(!current)return;
    void run(async(a,visible)=>{const result=await a.preview(current,receive?[]:selected,receive?[]:removals,receive);if(visible())setPreview(result);});};
  const confirm=()=>{const current=preview;if(!current)return;setPreview(null);setSelected([]);setRemovals([]);
    void run(async(a,visible)=>{await a.confirm(current);if(visible())return a.read();});};
  const execute=(action:'packages'|'resume'|'cancel')=>{
    const n=epoch.current;
    const submit=()=>{if(!focused.current || epoch.current!==n)return;setPreview(null);
      void run(async(a,visible)=>{if(action==='packages')await a.publishPackages();else if(action==='resume')await a.resume();else await a.cancel();
        if(visible())return a.read();});};
    if(action==='resume'){submit();return;}
    Alert.alert(t(action==='packages'?'group.packages':'group.cancel'),t(action==='packages'?'group.packagesBody':'group.cancelBody'),[
      {text:t('common.cancel'),style:'cancel'},{text:t(action==='packages'?'group.packages':'group.cancel'),onPress:submit},
    ],dismissible());
  };
  return <View style={[styles.card,{borderColor:c.border}]}>
    <Action c={c} label={t('group.title')} onPress={()=>setExpanded(v=>!v)} disabled={busy}/>
    {expanded && <>
      {busy && <ActivityIndicator color={c.accent}/>}
      {view && !preview && <>
        <Text style={[styles.text,{color:c.text}]}>{t(view.pending?'group.pending':view.accepted?'group.accepted':view.roster.group?'group.notAdmitted':'group.empty')}</Text>
        {view.accepted && <Text selectable style={[styles.text,{color:c.secondaryText}]}>{t('group.epoch',{epoch:view.accepted.epoch,revision:view.accepted.revision})}</Text>}
        {view.needs_credential_update && <Text accessibilityRole="alert" style={[styles.text,{color:c.secondaryText}]}>{t('group.credentialUpdate')}</Text>}
        <Action c={c} label={t('group.packages')} onPress={()=>execute('packages')} disabled={busy}/>
        {view.pending ? <>
          <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{view.pending.operation}</Text>
          <Action c={c} label={t('group.resume')} onPress={()=>execute('resume')} disabled={busy}/>
          <Action c={c} label={t('group.cancel')} onPress={()=>execute('cancel')} disabled={busy}/>
        </> : <>
          {view.event && <Action c={c} label={t('group.previewEvent')} onPress={()=>prepare(true)} disabled={busy}/>}
          {(!view.roster.group || view.accepted && !view.event) && <>
            <Text style={[styles.text,{color:c.secondaryText}]}>{t('group.chooseDevices')}</Text>
            {view.eligible.map(d=><Action key={d.device} c={c} label={`${selected.includes(d.device)?'☑':'☐'} ${who(d.user)} · ${d.device}${d.replacement?` · ${t('group.replaceDevice')}`:''}`} onPress={()=>toggle(d.device)} disabled={busy}/>)}
            {view.participants.map(p=><View key={p.device} style={styles.device}>
              <Text style={[styles.text,{color:c.text}]}>{who(p.user)} · {p.device}</Text>
              <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{p.certificate}</Text>
              {p.device!==view.own_device && <Action c={c} label={`${removals.includes(p.device)?'☑':'☐'} ${t('group.removeDevice')}`} onPress={()=>toggle(p.device,true)} disabled={busy}/>}
            </View>)}
            <Action c={c} label={t(view.roster.group?'group.previewChange':'group.previewCreate')} onPress={()=>prepare()} disabled={busy}/>
          </>}
        </>}
      </>}
      {preview && <>
        <Text style={[styles.text,{color:c.text}]}>{t(kinds[preview.kind])}</Text>
        <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{preview.fingerprint}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('group.confirmBody')}</Text>
        {preview.recipients.map(p=><View key={p.device} style={styles.device}>
          <Text style={[styles.text,{color:c.text}]}>{who(p.user)} · {p.device}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{p.root}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{p.certificate}</Text>
        </View>)}
        <Action c={c} label={t(kinds[preview.kind])} onPress={()=>confirm()} disabled={busy}/>
        <Action c={c} label={t('common.cancel')} onPress={()=>reload()} disabled={busy}/>
      </>}
      {failed && <Text accessibilityRole="alert" style={[styles.text,{color:c.errorText}]}>{t(failed==='untrusted'?'group.untrusted':'group.failed')}</Text>}
      <Action c={c} label={t('devices.refresh')} onPress={()=>reload()} disabled={busy}/>
    </>}
  </View>;
}
const styles=StyleSheet.create({card:{borderRadius:14,borderWidth:1,padding:12,gap:10},device:{gap:6,paddingVertical:8},
  text:{fontFamily:FONTS.body,fontSize:13,lineHeight:18},fingerprint:{fontFamily:FONTS.body,fontSize:12,lineHeight:18},
  action:{fontFamily:FONTS.bodyBold,fontSize:13,paddingVertical:8}});
