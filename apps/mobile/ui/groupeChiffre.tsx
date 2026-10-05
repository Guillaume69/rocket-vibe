import {useCallback,useEffect,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import {CryptoNative,type CryptoGroupPreview} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {CryptoGroupAccess,CryptoGroupView} from '../fournisseurs/rocketvibe/cryptoGroups.ts';
import {useSynchro} from './synchro.tsx';
import {useT} from './i18n.ts';
import {Appuyable} from './appuyable.tsx';
import {POLICES,type Couleurs} from './theme.ts';
import type {CleTraduction} from './messages.ts';

function Action({c,label,onPress,disabled}:{c:Couleurs;label:string;onPress:()=>void;disabled:boolean}) {
  return <Appuyable disabled={disabled} accessibilityRole="button" onPress={onPress}>
    <Text style={[styles.action,{color:c.cyan}]}>{label}</Text></Appuyable>;
}
export function SectionGroupeChiffre({c,room,membership}:{c:Couleurs;room:string;membership:string}) {
  const sync=useSynchro(),chat=sync.phase==='pret'?sync.fournisseur.native?.chat:null;
  return CryptoNative && chat?.capabilities?.e2ee && chat.capabilities.device_sessions
    ? <Groupe key={`${JSON.stringify(sync.phase==='pret'?sync.fournisseur.identite:null)}:${room}:${membership}`} c={c} room={room} membership={membership} chat={chat}/> : null;
}
const kinds:Record<CryptoGroupPreview['kind'],CleTraduction>={genesis:'group.create',change:'group.change',admission:'group.join',readmission:'group.rejoin',commit:'group.receive'};
function Groupe({c,room,membership,chat}:{c:Couleurs;room:string;membership:string;chat:NativeChat}) {
  const t=useT(),[expanded,setExpanded]=useState(false),[view,setView]=useState<CryptoGroupView|null>(null);
  const [preview,setPreview]=useState<CryptoGroupPreview|null>(null),[selected,setSelected]=useState<string[]>([]),[removals,setRemovals]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null),access=useRef<CryptoGroupAccess|null>(null);
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
    } catch {if(visible()){setFailed(true);setView(null);setPreview(null);setSelected([]);setRemovals([]);}}
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
      {text:t('commun.annuler'),style:'cancel'},{text:t(action==='packages'?'group.packages':'group.cancel'),onPress:submit},
    ]);
  };
  return <View style={[styles.card,{borderColor:c.bordure}]}>
    <Action c={c} label={t('group.title')} onPress={()=>setExpanded(v=>!v)} disabled={busy}/>
    {expanded && <>
      {busy && <ActivityIndicator color={c.accent}/>}
      {view && !preview && <>
        <Text style={[styles.text,{color:c.texte}]}>{t(view.pending?'group.pending':view.accepted?'group.accepted':view.roster.group?'group.notAdmitted':'group.empty')}</Text>
        {view.accepted && <Text selectable style={[styles.text,{color:c.texteSecondaire}]}>{t('group.epoch',{epoch:view.accepted.epoch,revision:view.accepted.revision})}</Text>}
        {view.needs_credential_update && <Text accessibilityRole="alert" style={[styles.text,{color:c.texteSecondaire}]}>{t('group.credentialUpdate')}</Text>}
        <Action c={c} label={t('group.packages')} onPress={()=>execute('packages')} disabled={busy}/>
        {view.pending ? <>
          <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{view.pending.operation}</Text>
          <Action c={c} label={t('group.resume')} onPress={()=>execute('resume')} disabled={busy}/>
          <Action c={c} label={t('group.cancel')} onPress={()=>execute('cancel')} disabled={busy}/>
        </> : <>
          {view.event && <Action c={c} label={t('group.previewEvent')} onPress={()=>prepare(true)} disabled={busy}/>}
          {(!view.roster.group || view.accepted && !view.event) && <>
            <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('group.chooseDevices')}</Text>
            {view.eligible.map(d=><Action key={d.device} c={c} label={`${selected.includes(d.device)?'☑':'☐'} ${d.user} · ${d.device}${d.replacement?` · ${t('group.replaceDevice')}`:''}`} onPress={()=>toggle(d.device)} disabled={busy}/>)}
            {view.participants.map(p=><View key={p.device} style={styles.device}>
              <Text style={[styles.text,{color:c.texte}]}>{p.user} · {p.device}</Text>
              <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{p.certificate}</Text>
              {p.device!==view.own_device && <Action c={c} label={`${removals.includes(p.device)?'☑':'☐'} ${t('group.removeDevice')}`} onPress={()=>toggle(p.device,true)} disabled={busy}/>}
            </View>)}
            <Action c={c} label={t(view.roster.group?'group.previewChange':'group.previewCreate')} onPress={()=>prepare()} disabled={busy}/>
          </>}
        </>}
      </>}
      {preview && <>
        <Text style={[styles.text,{color:c.texte}]}>{t(kinds[preview.kind])}</Text>
        <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{preview.fingerprint}</Text>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('group.confirmBody')}</Text>
        {preview.recipients.map(p=><View key={p.device} style={styles.device}>
          <Text style={[styles.text,{color:c.texte}]}>{p.user} · {p.device}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{p.root}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{p.certificate}</Text>
        </View>)}
        <Action c={c} label={t(kinds[preview.kind])} onPress={()=>confirm()} disabled={busy}/>
        <Action c={c} label={t('commun.annuler')} onPress={()=>reload()} disabled={busy}/>
      </>}
      {failed && <Text accessibilityRole="alert" style={[styles.text,{color:c.texteErreur}]}>{t('group.failed')}</Text>}
      <Action c={c} label={t('devices.refresh')} onPress={()=>reload()} disabled={busy}/>
    </>}
  </View>;
}
const styles=StyleSheet.create({card:{borderRadius:14,borderWidth:1,padding:12,gap:10},device:{gap:6,paddingVertical:8},
  text:{fontFamily:POLICES.corps,fontSize:13,lineHeight:18},fingerprint:{fontFamily:POLICES.corps,fontSize:12,lineHeight:18},
  action:{fontFamily:POLICES.corpsGras,fontSize:13,paddingVertical:8}});
