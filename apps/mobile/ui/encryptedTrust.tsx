import {useCallback,useEffect,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import {CryptoNative,type CryptoPeerApproval,type CryptoPeerView} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {CryptoPeerAccess} from '../providers/rocketvibe/cryptoPeers.ts';
import {useSync} from './sync.tsx';
import {useT} from './i18n.ts';
import {Tappable} from './tappable.tsx';
import {PillField} from './kit.tsx';
import {FONTS,type Colors} from './theme.ts';
import type {TranslationKey} from './messages.ts';

const keys=new WeakMap<NativeChat,number>();let nextKey=0;
function key(chat:NativeChat):number {let n=keys.get(chat);if(n===undefined){n=++nextKey;keys.set(chat,n);}return n;}
const labels={unknown:'peer.unknown',unverified:'peer.unverified',verified:'peer.verified',changed:'peer.changed'} as const;
function Action({c,label,onPress,disabled}:{c:Colors;label:TranslationKey;onPress:()=>void;disabled:boolean}) {
  const t=useT();return <Tappable disabled={disabled} accessibilityRole="button" onPress={onPress}>
    <Text style={[styles.action,{color:c.cyan}]}>{t(label)}</Text></Tappable>;
}
export function EncryptedTrustSection({c,user}:{c:Colors;user:string}) {
  const sync=useSync(),chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  return CryptoNative && chat?.capabilities?.e2ee && chat.capabilities.device_sessions
    ? <Trust key={`${key(chat)}:${user}`} c={c} user={user} chat={chat}/> : null;
}
function Trust({c,user,chat}:{c:Colors;user:string;chat:NativeChat}) {
  const t=useT(),[expanded,setExpanded]=useState(false),[view,setView]=useState<CryptoPeerView|null>(null);
  const [approval,setApproval]=useState<CryptoPeerApproval|null>(null),[confirmed,setConfirmed]=useState('');
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null),access=useRef<CryptoPeerAccess|null>(null);
  const clear=useCallback(()=>{epoch.current++;job.current=null;void access.current?.close();access.current=null;
    setView(null);setApproval(null);setConfirmed('');setBusy(false);setFailed(false);},[]);
  const run=useCallback(async(action:(a:CryptoPeerAccess,visible:()=>boolean)=>Promise<CryptoPeerView|void>)=>{
    if(!focused.current || !expanded || job.current!==null || AppState.currentState!=='active' || !CryptoNative)return;
    const n=epoch.current,visible=()=>focused.current && epoch.current===n && AppState.currentState==='active';
    job.current=n;setBusy(true);setFailed(false);
    try {
      const a=access.current??await chat.cryptoPeer(CryptoNative,user,visible);
      if(!visible()){void a.close();return;}access.current=a;
      const result=await action(a,visible);if(visible() && result)setView(result);
    } catch {if(visible()){setFailed(true);setView(null);setApproval(null);setConfirmed('');}}
    finally {if(job.current===n){job.current=null;if(visible())setBusy(false);}}
  },[chat,user,expanded]);
  const reload=useCallback(()=>{setApproval(null);setConfirmed('');void run(a=>a.read());},[run]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();if(expanded)reload();return()=>{focused.current=false;clear();};},[clear,expanded,reload]));
  useEffect(()=>{const sub=AppState.addEventListener('change',state=>{if(state!=='active')clear();else if(focused.current && expanded)reload();});
    return()=>sub.remove();},[clear,expanded,reload]);
  const pin=(choice:'first_contact'|'verify'|'replace')=>{
    const selected=view,n=epoch.current;if(!selected)return;
    const value=choice==='first_contact'?selected.fingerprint:confirmed.trim();
    const submit=()=>{if(focused.current && epoch.current===n){setConfirmed('');void run(a=>a.pin(selected,choice,value));}};
    if(choice==='verify'){submit();return;}
    Alert.alert(t(choice==='replace'?'peer.replace':'peer.firstContact'),t(choice==='replace'?'peer.replaceBody':'peer.firstContactBody'),[
      {text:t('common.cancel'),style:'cancel'},{text:t(choice==='replace'?'peer.replace':'peer.firstContact'),onPress:submit},
    ]);
  };
  const preview=(device:string)=>{const selected=view;if(!selected)return;setApproval(null);
    void run(async(a,visible)=>{const result=await a.preview(selected,device);if(visible())setApproval(result);});};
  const approve=()=>{const selected=approval;if(!selected)return;setApproval(null);void run(a=>a.approve(selected));};
  return <View style={[styles.card,{borderColor:c.border}]}>
    <Action c={c} label="peer.title" onPress={()=>setExpanded(v=>!v)} disabled={busy}/>
    {expanded && <>
      {busy && <ActivityIndicator color={c.accent}/>}
      {view && <>
        <Text style={[styles.text,{color:view.trust==='changed'?c.errorText:c.text}]}>{t(labels[view.trust])}</Text>
        {view.fingerprint ? <>
          <Text style={[styles.text,{color:c.secondaryText}]}>{t('peer.root')}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.text}]}>{view.fingerprint}</Text>
          {view.trust==='unknown' && <Action c={c} label="peer.firstContact" onPress={()=>pin('first_contact')} disabled={busy||!!approval}/>}
          {view.trust==='changed' && <>
            <Text style={[styles.text,{color:c.secondaryText}]}>{t('peer.previous')}</Text>
            <Text selectable style={[styles.fingerprint,{color:c.text}]}>{view.previous_fingerprint}</Text>
          </>}
          {(view.trust==='unverified' || view.trust==='changed') && <>
            <Text style={[styles.text,{color:c.secondaryText}]}>{t('peer.compare')}</Text>
            <PillField c={c} label={t('private.comparedFingerprint')} value={confirmed} onChangeText={setConfirmed} editable={!busy && !approval} maxLength={64} autoCapitalize="none" autoCorrect={false}/>
            <Action c={c} label={view.trust==='changed'?'peer.replace':'peer.verify'} onPress={()=>pin(view.trust==='changed'?'replace':'verify')} disabled={busy||!!approval || confirmed.trim()!==view.fingerprint}/>
          </>}
          {view.devices.map(device=><View key={device.id} style={styles.device}>
            <Text selectable style={[styles.text,{color:c.text}]}>{device.id}</Text>
            <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{device.fingerprint}</Text>
            <Text style={[styles.text,{color:c.dimmed}]}>{t(device.approved?'peer.approved':'peer.notApproved')}</Text>
            {!device.approved && (view.trust==='unverified' || view.trust==='verified')
              && <Action c={c} label="peer.previewDevice" onPress={()=>preview(device.id)} disabled={busy||!!approval}/>}
          </View>)}
        </> : <Text style={[styles.text,{color:c.secondaryText}]}>{t('peer.missing')}</Text>}
      </>}
      {approval && <>
        <Text style={[styles.text,{color:c.text}]}>{approval.device}</Text>
        <Text selectable style={[styles.fingerprint,{color:c.text}]}>{approval.rootFingerprint}</Text>
        <Text selectable style={[styles.fingerprint,{color:c.text}]}>{approval.fingerprint}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('peer.approveBody')}</Text>
        <Action c={c} label="peer.approveDevice" onPress={()=>approve()} disabled={busy}/>
        <Action c={c} label="common.cancel" onPress={()=>reload()} disabled={busy}/>
      </>}
      {failed && <Text accessibilityRole="alert" style={[styles.text,{color:c.errorText}]}>{t('peer.failed')}</Text>}
      <Action c={c} label="devices.refresh" onPress={()=>reload()} disabled={busy}/>
    </>}
  </View>;
}
const styles=StyleSheet.create({card:{borderRadius:14,borderWidth:1,padding:12,gap:10},device:{gap:6,paddingVertical:8},
  text:{fontFamily:FONTS.body,fontSize:13,lineHeight:18},fingerprint:{fontFamily:FONTS.body,fontSize:12,lineHeight:18},
  action:{fontFamily:FONTS.bodyBold,fontSize:13,paddingVertical:8}});
