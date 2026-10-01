import {useCallback,useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {FactorView} from '../fournisseurs/rocketvibe/factorVault.ts';
import type {FactorStatus,SecondFactor} from '../fournisseurs/rocketvibe/protocol.generated.ts';
import type {ReauthenticationView,SecurityGuard} from '../fournisseurs/rocketvibe/reauthenticationVault.ts';
import {NativeError} from '../fournisseurs/rocketvibe/transport.ts';
import {nativeFactorVault,nativeReauthenticationVault} from '../lib/nativeSecurityStore.ts';
import {Appuyable} from './appuyable.tsx';
import {useT} from './i18n.ts';
import {ChampPilule} from './kit.tsx';
import type {CleTraduction} from './messages.ts';
import {useSynchro} from './synchro.tsx';
import {POLICES,type Couleurs} from './theme.ts';

const keys=new WeakMap<NativeChat,number>();let nextKey=0;
function key(chat:NativeChat):number {let k=keys.get(chat);if(k===undefined){k=++nextKey;keys.set(chat,k);}return k;}
export function SectionSecuriteNative({c}:{c:Couleurs}) {
  const sync=useSynchro(),chat=sync.phase==='pret'?sync.fournisseur.native?.chat:null;
  return chat?.capabilities?.reauthentication && chat.capabilities.reauthentication_retirement
    ? <SecuriteNative key={key(chat)} c={c} chat={chat} reauthOnly={!chat.capabilities.second_factors}/> : null;
}
export function ConfirmerIdentiteNative({c,chat,onConfirmed}:{c:Couleurs;chat:NativeChat;onConfirmed:()=>void}) {
  return <SecuriteNative c={c} chat={chat} reauthOnly onConfirmed={onConfirmed}/>;
}
type Access=Awaited<ReturnType<NativeChat['security']>>;
function Action({c,label,onPress,disabled}:{c:Couleurs;label:CleTraduction;onPress:()=>void;disabled:boolean}) {
  const t=useT();return <Appuyable disabled={disabled} accessibilityRole="button" onPress={onPress}><Text style={[styles.action,{color:c.cyan,opacity:disabled?0.5:1}]}>{t(label)}</Text></Appuyable>;
}
function SecuriteNative({c,chat,reauthOnly=false,onConfirmed}:{c:Couleurs;chat:NativeChat;reauthOnly?:boolean;onConfirmed?:()=>void}) {
  const t=useT(),focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<CleTraduction|null>(null);
  const [factor,setFactor]=useState<FactorStatus|null>(null),[view,setView]=useState<FactorView>({kind:'idle'});
  const [proof,setProof]=useState<ReauthenticationView>({kind:'password'});
  const [password,setPassword]=useState(''),[code,setCode]=useState(''),[method,setMethod]=useState<SecondFactor>('totp');
  const confirmed=useRef(onConfirmed);useEffect(()=>{confirmed.current=onConfirmed;},[onConfirmed]);
  const clear=useCallback(()=>{setPassword('');setCode('');setView({kind:'idle'});setProof({kind:'password'});},[]);
  const run=useCallback(async(action:(access:Access,guard:SecurityGuard)=>Promise<void>)=>{
    if(!focused.current || job.current!==null || AppState.currentState!=='active')return;
    const n=epoch.current;job.current=n;setBusy(true);setError(null);
    const visible=()=>focused.current && epoch.current===n && AppState.currentState==='active';
    try{
      const access=await chat.security(visible),guard=()=>visible() && access.alive();
      if(!guard())return;
      await action(access,guard);
      if(!guard())return;
      const status=await access.remote.status();if(guard())setFactor(status);
      if(!guard())return;
      const latest=await access.remote.proof.status();
      if(guard() && !latest.recent)setProof(current=>current.kind==='ready'?{kind:'password'}:current);
    }catch(e){
      if(visible()){
        if(e instanceof NativeError && e.code==='reauthentication_required'){setProof({kind:'password'});setError('security.required');}
        else if(e instanceof NativeError && ['factor_rejected','reauthentication_rejected'].includes(e.code))setError('security.rejected');
        else setError('security.failed');
        if(e instanceof NativeError && ['session_closed','server_identity_changed','session_rejected'].includes(e.code))clear();
      }
    }finally{if(job.current===n){job.current=null;if(visible())setBusy(false);}}
  },[chat,clear]);
  const reload=useCallback(()=>run(async(access,guard)=>{
    const result=await nativeReauthenticationVault.prepare(access.scope,access.remote.proof,'',guard);if(!guard())return;
    setProof(result);
    if(result.kind==='ready' && reauthOnly)confirmed.current?.();
    if(result.kind==='challenge')setMethod(result.attempt.challenge?.methods.includes('totp')?'totp':'recovery_code');
    if(!reauthOnly){const restored=await nativeFactorVault.resume(access.scope,access.remote,guard);if(guard())setView(restored);}
  }),[reauthOnly,run]);
  useFocusEffect(useCallback(()=>{
    focused.current=true;epoch.current++;job.current=null;setBusy(false);void reload();
    return ()=>{focused.current=false;epoch.current++;job.current=null;clear();};
  },[clear,reload]));
  useEffect(()=>{
    const subscription=AppState.addEventListener('change',state=>{
      if(state!=='active'){epoch.current++;job.current=null;setBusy(false);clear();}
    });return ()=>subscription.remove();
  },[clear]);
  const acceptProof=(result:ReauthenticationView,guard:SecurityGuard)=>{
    if(!guard())return;setProof(result);
    if(result.kind==='challenge')setMethod(result.attempt.challenge?.methods.includes('totp')?'totp':'recovery_code');
    if(result.kind==='ready' && reauthOnly)confirmed.current?.();
  };
  const startProof=()=>{const entered=password;setPassword('');void run(async(access,guard)=>acceptProof(await nativeReauthenticationVault.prepare(access.scope,access.remote.proof,entered,guard),guard));};
  const finishProof=()=>{const entered=code;setCode('');const expected=proof;
    if(expected.kind==='challenge')void run(async(access,guard)=>acceptProof(await nativeReauthenticationVault.finish(expected.attempt,access.remote.proof,method,entered,guard),guard));
  };
  const start=(kind:'setup'|'regenerate'|'disable')=>void run(async(access,guard)=>{
    const result=await nativeFactorVault.start(access.scope,access.remote,kind,guard);if(guard())setView(result);
  });
  const confirm=(kind:'regenerate'|'disable')=>{
    // Retained native alerts are bound to this focus and runner, too.
    const n=epoch.current;
    Alert.alert(t(kind==='disable'?'security.disable':'security.regenerate'),t(kind==='disable'?'security.disableBody':'security.regenerateBody'),[
      {text:t('commun.annuler'),style:'cancel'},
      {text:t('connexion.valider'),style:'destructive',onPress:()=>{if(focused.current && epoch.current===n)start(kind);}},
    ]);
  };
  const enable=()=>{const entered=code;setCode('');const expected=view;
    if(expected.kind==='setup')void run(async(access,guard)=>{
      const result=await nativeFactorVault.enable(access.scope,access.remote,expected.setup,entered,guard);if(guard())setView(result);
    });
  };
  const acknowledge=()=>{const expected=view;
    if(expected.kind==='codes' || expected.kind==='stale')void run(async(access,guard)=>{
      if(await nativeFactorVault.clear(access.scope,expected.receipt,guard)){if(guard())setView({kind:'idle'});}
    });
  };
  const copy=(kind:'secret'|'uri'|'codes')=>{const expected=view;void run(async(access,guard)=>{
    const latest=await nativeFactorVault.resume(access.scope,access.remote,guard);if(!guard())return;setView(latest);
    if(kind==='codes' && latest.kind==='codes' && expected.kind==='codes' && latest.receipt===expected.receipt){await Clipboard.setStringAsync(latest.codes.codes.join('\n'));return;}
    if(kind!=='codes' && latest.kind==='setup' && expected.kind==='setup' && latest.setup.setup_id===expected.setup.setup_id){await Clipboard.setStringAsync(kind==='secret'?latest.setup.secret:latest.setup.provisioning_uri);return;}
    throw new NativeError(409,'credentials_changed');
  });};
  return <>
    <Text style={[styles.heading,{color:c.attenue}]}>{t('security.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.carteProfonde,borderColor:c.bordure}]}>
      {busy && <ActivityIndicator color={c.accent}/>}
      {!reauthOnly && factor && <Text style={[styles.text,{color:c.texte}]}>{t(factor.totp?'security.enabled':'security.disabled')}{factor.totp?` · ${t('security.remaining',{n:factor.backup_codes_remaining})}`:''}</Text>}
      {proof.kind==='ready' ? <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.ready')}</Text> : <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.required')}</Text>
        {proof.kind==='password' && <>
          <ChampPilule c={c} etiquette={t('connexion.motDePasse')} valeur={password} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={1024} editable={!busy} onChangeText={setPassword}/>
          <Action c={c} label="security.verify" onPress={startProof} disabled={busy || !password}/>
        </>}
        {proof.kind==='challenge' && <>
          {proof.attempt.challenge?.methods.includes('totp') && <Action c={c} label="connexion.utiliserTotp" onPress={()=>{setCode('');setMethod('totp');}} disabled={busy}/>}
          {proof.attempt.challenge?.methods.includes('recovery_code') && <Action c={c} label="connexion.utiliserSecours" onPress={()=>{setCode('');setMethod('recovery_code');}} disabled={busy}/>}
          <ChampPilule c={c} etiquette={t(method==='totp'?'connexion.etiquetteTotp':'connexion.codeSecours')} valeur={code} autoCapitalize="none" autoCorrect={false} keyboardType={method==='totp'?'number-pad':'default'} maxLength={128} editable={!busy} onChangeText={setCode}/>
          <Action c={c} label="security.verify" onPress={finishProof} disabled={busy}/>
        </>}
      </>}
      {!reauthOnly && view.kind==='setup' && <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.setupBody')}</Text>
        <Text selectable style={[styles.secret,{color:c.texte}]}>{view.setup.secret}</Text>
        <Action c={c} label="security.copySecret" onPress={()=>copy('secret')} disabled={busy}/>
        <Action c={c} label="security.copyUri" onPress={()=>copy('uri')} disabled={busy}/>
        <ChampPilule c={c} etiquette={t('connexion.etiquetteTotp')} valeur={code} keyboardType="number-pad" autoCorrect={false} maxLength={6} editable={!busy} onChangeText={setCode}/>
        <Action c={c} label="security.enable" onPress={enable} disabled={busy || !code}/>
      </>}
      {!reauthOnly && view.kind==='codes' && <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.codesBody')}</Text>
        <Text selectable style={[styles.secret,{color:c.texte}]}>{view.codes.codes.join('\n')}</Text>
        <Action c={c} label="security.copyCodes" onPress={()=>copy('codes')} disabled={busy}/>
        <Action c={c} label="security.saved" onPress={acknowledge} disabled={busy}/>
      </>}
      {!reauthOnly && view.kind==='stale' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.stale')}</Text><Action c={c} label="security.discard" onPress={acknowledge} disabled={busy}/></>}
      {!reauthOnly && view.kind==='idle' && factor && <>
        {factor.totp? <><Action c={c} label="security.regenerate" onPress={()=>confirm('regenerate')} disabled={busy}/><Action c={c} label="security.disable" onPress={()=>confirm('disable')} disabled={busy}/></> : <Action c={c} label="security.setup" onPress={()=>start('setup')} disabled={busy}/>}
      </>}
      {error && <Text accessibilityRole="alert" style={[styles.text,{color:c.texteErreur}]}>{t(error)}</Text>}
      <Action c={c} label="security.refresh" onPress={()=>void reload()} disabled={busy}/>
    </View>
  </>;
}
const styles=StyleSheet.create({
  heading:{fontFamily:POLICES.corpsFort,fontSize:11,textTransform:'uppercase',letterSpacing:0.6,marginTop:8,marginLeft:4},
  card:{borderRadius:16,borderWidth:1,padding:16,gap:10},
  text:{fontFamily:POLICES.corps,fontSize:13,lineHeight:18},
  secret:{fontFamily:POLICES.corpsGras,fontSize:13,lineHeight:24},
  action:{fontFamily:POLICES.corpsGras,fontSize:13,paddingVertical:8},
});
