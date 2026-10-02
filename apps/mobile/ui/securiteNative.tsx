import {useCallback,useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {FactorView} from '../fournisseurs/rocketvibe/factorVault.ts';
import type {EmailView} from '../fournisseurs/rocketvibe/emailVault.ts';
import type {FactorStatus,SecondFactor} from '../fournisseurs/rocketvibe/protocol.generated.ts';
import type {ReauthenticationView,SecurityGuard} from '../fournisseurs/rocketvibe/reauthenticationVault.ts';
import {NativeError} from '../fournisseurs/rocketvibe/transport.ts';
import {nativeEmailVault,nativeFactorVault,nativeReauthenticationVault} from '../lib/nativeSecurityStore.ts';
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
    ? <SecuriteNative key={key(chat)} c={c} chat={chat}/> : null;
}
export function ConfirmerIdentiteNative({c,chat,onConfirmed}:{c:Couleurs;chat:NativeChat;onConfirmed:()=>void}) {
  return <SecuriteNative c={c} chat={chat} reauthOnly onConfirmed={onConfirmed}/>;
}
type Access=Awaited<ReturnType<NativeChat['security']>>;
const deliveryLabels={queued:'email.queued',sending:'email.sending',deferred:'email.deferred',accepted:'email.accepted',exhausted:'email.exhausted'} as const;
function Action({c,label,onPress,disabled}:{c:Couleurs;label:CleTraduction;onPress:()=>void;disabled:boolean}) {
  const t=useT();return <Appuyable disabled={disabled} accessibilityRole="button" onPress={onPress}><Text style={[styles.action,{color:c.cyan,opacity:disabled?0.5:1}]}>{t(label)}</Text></Appuyable>;
}
function SecuriteNative({c,chat,reauthOnly=false,onConfirmed}:{c:Couleurs;chat:NativeChat;reauthOnly?:boolean;onConfirmed?:()=>void}) {
  const t=useT(),focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<CleTraduction|null>(null);
  const [factor,setFactor]=useState<FactorStatus|null>(null),[view,setView]=useState<FactorView>({kind:'idle'});
  const [proof,setProof]=useState<ReauthenticationView>({kind:'password'});
  const [password,setPassword]=useState(''),[code,setCode]=useState(''),[method,setMethod]=useState<SecondFactor>('totp');
  const [emailView,setEmailView]=useState<EmailView|null>(null),[emailAddress,setEmailAddress]=useState(''),[emailCode,setEmailCode]=useState('');
  const emailRevision=useRef(0),emailAvailable=!reauthOnly && !!(chat.capabilities?.email_verification || chat.capabilities?.email_removal),factorAvailable=!reauthOnly && !!chat.capabilities?.second_factors;
  const publishEmail=useCallback((next:EmailView)=>{emailRevision.current++;setEmailView(next);},[]);
  useEffect(()=>{if(proof.kind!=='ready')setEmailCode('');},[proof.kind]);
  const confirmed=useRef(onConfirmed);useEffect(()=>{confirmed.current=onConfirmed;},[onConfirmed]);
  const clear=useCallback(()=>{setPassword('');setCode('');setView({kind:'idle'});setProof({kind:'password'});emailRevision.current++;setEmailView(null);setEmailAddress('');setEmailCode('');},[]);
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
        else if(e instanceof NativeError && e.code==='invalid_email_address')setError('email.invalid');
        else if(e instanceof NativeError && e.code==='email_verification_rejected')setError('email.rejected');
        else if(e instanceof NativeError && e.code==='email_removal_rejected')setError('email.removalRejected');
        else if(e instanceof NativeError && ['email_delivery_limit','email_queue_limit','email_resend_cooldown','email_challenge_delivery_limit'].includes(e.code))setError('email.limited');
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
    if(result.kind==='challenge')setMethod(result.attempt.challenge?.methods.includes('totp')?'totp':result.attempt.challenge?.methods.includes('email')?'email':'recovery_code');
    if(factorAvailable){const restored=await nativeFactorVault.resume(access.scope,access.remote,guard);if(guard())setView(restored);}
    if(emailAvailable){const restored=await nativeEmailVault.resume(access.scope,access.email,guard);if(guard())publishEmail(restored);}
  }),[emailAvailable,factorAvailable,publishEmail,reauthOnly,run]);
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
    if(result.kind==='challenge')setMethod(result.attempt.challenge?.methods.includes('totp')?'totp':result.attempt.challenge?.methods.includes('email')?'email':'recovery_code');
    if(result.kind==='ready' && reauthOnly)confirmed.current?.();
  };
  const updateEmail=async(access:Access,guard:SecurityGuard)=>{if(emailAvailable){const result=await nativeEmailVault.resume(access.scope,access.email,guard);if(guard())publishEmail(result);}};
  const startProof=()=>{const entered=password;setPassword('');void run(async(access,guard)=>{
    const result=await nativeReauthenticationVault.prepare(access.scope,access.remote.proof,entered,guard);acceptProof(result,guard);
    if(result.kind==='ready' && guard())await updateEmail(access,guard);
  });};
  const finishProof=()=>{const entered=code;setCode('');const expected=proof;
    if(expected.kind==='challenge')void run(async(access,guard)=>{
      const result=await nativeReauthenticationVault.finish(expected.attempt,access.remote.proof,method,entered,guard);acceptProof(result,guard);
      if(result.kind==='ready' && guard())await updateEmail(access,guard);
    });
  };
  const sendProofEmail=(resend=false)=>{const expected=proof;
    if(expected.kind==='challenge')void run(async(access,guard)=>{
      const result=await nativeReauthenticationVault.sendEmail(expected.attempt,access.remote.proof,resend,guard);
      acceptProof(result,guard);
    });
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
  const startEmail=()=>{const expected=emailView,entered=emailAddress;setEmailAddress('');setEmailCode('');
    if(expected?.kind==='idle')void run(async(access,guard)=>{const next=await nativeEmailVault.start(access.scope,access.email,entered,expected.status,guard);if(guard())publishEmail(next);});
  };
  const confirmEmail=()=>{const expected=emailView,entered=emailCode;setEmailCode('');
    if(expected?.kind==='pending')void run(async(access,guard)=>{const next=await nativeEmailVault.confirm(access.scope,access.email,expected.receipt,entered,guard);if(guard())publishEmail(next);});
  };
  const closeEmail=()=>{const expected=emailView;setEmailCode('');
    if(expected && expected.kind!=='idle')void run(async(access,guard)=>{
      const next=await (expected.kind==='verified' || expected.kind==='removed'?nativeEmailVault.acknowledge(access.scope,access.email,expected.receipt,guard):nativeEmailVault.cancel(access.scope,access.email,expected.receipt,guard));if(guard())publishEmail(next);
    });
  };
  const removeEmail=()=>{
    const expected=emailView,n=epoch.current,revision=emailRevision.current;
    if(expected?.kind!=='idle' || !expected.status.address)return;
    Alert.alert(t('email.remove'),t('email.removeBody',{address:expected.status.address}),[
      {text:t('commun.annuler'),style:'cancel'},
      {text:t('email.remove'),style:'destructive',onPress:()=>{
        if(!focused.current || epoch.current!==n || emailRevision.current!==revision)return;
        setEmailAddress('');setEmailCode('');
        void run(async(access,guard)=>{
          const approved=()=>guard() && emailRevision.current===revision;
          if(!approved())return;
          const next=await nativeEmailVault.removeContact(access.scope,access.email,expected.status,approved);
          if(approved())publishEmail(next);
        });
      }},
    ]);
  };
  return <>
    <Text style={[styles.heading,{color:c.attenue}]}>{t('security.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.carteProfonde,borderColor:c.bordure}]}>
      {busy && <ActivityIndicator color={c.accent}/>}
      {factorAvailable && factor && <Text style={[styles.text,{color:c.texte}]}>{t(factor.totp?'security.enabled':'security.disabled')}{factor.totp?` · ${t('security.remaining',{n:factor.backup_codes_remaining})}`:''}</Text>}
      {proof.kind==='ready' ? <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.ready')}</Text> : <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.required')}</Text>
        {proof.kind==='password' && <>
          <ChampPilule c={c} etiquette={t('connexion.motDePasse')} valeur={password} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={1024} editable={!busy} onChangeText={setPassword}/>
          <Action c={c} label="security.verify" onPress={startProof} disabled={busy || !password}/>
        </>}
        {proof.kind==='challenge' && <>
          {proof.attempt.challenge?.methods.includes('totp') && <Action c={c} label="connexion.utiliserTotp" onPress={()=>{setCode('');setMethod('totp');}} disabled={busy}/>}
          {proof.attempt.challenge?.methods.includes('recovery_code') && <Action c={c} label="connexion.utiliserSecours" onPress={()=>{setCode('');setMethod('recovery_code');}} disabled={busy}/>}
          {proof.attempt.challenge?.methods.includes('email') && <Action c={c} label="connexion.utiliserEmail" onPress={()=>{setCode('');setMethod('email');}} disabled={busy}/>}
          {method==='email' && <>
            <Action c={c} label={proof.attempt.email?'email.resumeDelivery':'connexion.envoyerLeCode'} onPress={()=>sendProofEmail()} disabled={busy}/>
            {proof.attempt.email?.status && <>
              <Text style={[styles.text,{color:c.texteSecondaire}]}>{t(deliveryLabels[proof.attempt.email.status.delivery])}</Text>
              <Action c={c} label="connexion.renvoyerCode" onPress={()=>sendProofEmail(true)} disabled={busy}/>
            </>}
          </>}
          <ChampPilule c={c} etiquette={t(method==='totp'?'connexion.etiquetteTotp':method==='email'?'email.code':'connexion.codeSecours')} valeur={code} autoCapitalize="none" autoCorrect={false} keyboardType={method==='recovery_code'?'default':'number-pad'} autoComplete={method==='recovery_code'?'off':'one-time-code'} maxLength={method==='email'?8:128} editable={!busy} onChangeText={setCode}/>
          <Action c={c} label="security.verify" onPress={finishProof} disabled={busy}/>
        </>}
      </>}
      {factorAvailable && view.kind==='setup' && <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.setupBody')}</Text>
        <Text selectable style={[styles.secret,{color:c.texte}]}>{view.setup.secret}</Text>
        <Action c={c} label="security.copySecret" onPress={()=>copy('secret')} disabled={busy}/>
        <Action c={c} label="security.copyUri" onPress={()=>copy('uri')} disabled={busy}/>
        <ChampPilule c={c} etiquette={t('connexion.etiquetteTotp')} valeur={code} keyboardType="number-pad" autoCorrect={false} maxLength={6} editable={!busy} onChangeText={setCode}/>
        <Action c={c} label="security.enable" onPress={enable} disabled={busy || !code}/>
      </>}
      {factorAvailable && view.kind==='codes' && <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.codesBody')}</Text>
        <Text selectable style={[styles.secret,{color:c.texte}]}>{view.codes.codes.join('\n')}</Text>
        <Action c={c} label="security.copyCodes" onPress={()=>copy('codes')} disabled={busy}/>
        <Action c={c} label="security.saved" onPress={acknowledge} disabled={busy}/>
      </>}
      {factorAvailable && view.kind==='stale' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('security.stale')}</Text><Action c={c} label="security.discard" onPress={acknowledge} disabled={busy}/></>}
      {factorAvailable && view.kind==='idle' && factor && <>
        {factor.totp? <><Action c={c} label="security.regenerate" onPress={()=>confirm('regenerate')} disabled={busy}/><Action c={c} label="security.disable" onPress={()=>confirm('disable')} disabled={busy}/></> : <Action c={c} label="security.setup" onPress={()=>start('setup')} disabled={busy}/>}
      </>}
      {emailAvailable && emailView && <>
        <Text style={[styles.text,{color:c.texte}]}>{t('email.title')}</Text>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.private')}</Text>
        <Text selectable style={[styles.text,{color:c.texte}]}>{emailView.status.address?t('email.current',{address:emailView.status.address}):t('email.none')}</Text>
        {emailView.kind==='idle' && <>
          {chat.capabilities?.email_verification && <>
            <ChampPilule c={c} etiquette={t('email.address')} valeur={emailAddress} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} maxLength={254} editable={!busy} onChangeText={setEmailAddress}/>
            <Action c={c} label="email.start" onPress={startEmail} disabled={busy || proof.kind!=='ready' || !emailAddress}/>
          </>}
          {chat.capabilities?.email_removal && emailView.status.address && <Action c={c} label="email.remove" onPress={removeEmail} disabled={busy || proof.kind!=='ready'}/>}
        </>}
        {emailView.kind==='pending' && <>
          <Text selectable style={[styles.text,{color:c.texteSecondaire}]}>{t('email.pending',{address:emailView.address})}</Text>
          <Text style={[styles.text,{color:c.texteSecondaire}]}>{t(deliveryLabels[emailView.delivery])}</Text>
          <ChampPilule c={c} etiquette={t('email.code')} valeur={emailCode} keyboardType="number-pad" autoCapitalize="none" autoCorrect={false} maxLength={8} editable={!busy && proof.kind==='ready'} onChangeText={setEmailCode}/>
          <Action c={c} label="email.confirm" onPress={confirmEmail} disabled={busy || proof.kind!=='ready' || !/^\d{8}$/.test(emailCode)}/>
          <Action c={c} label="email.cancel" onPress={closeEmail} disabled={busy}/>
        </>}
        {emailView.kind==='verified' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.verified')}</Text><Action c={c} label="email.done" onPress={closeEmail} disabled={busy}/></>}
        {emailView.kind==='stale' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.stale')}</Text><Action c={c} label="email.restart" onPress={closeEmail} disabled={busy}/></>}
        {emailView.kind==='removal_pending' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.removalPending')}</Text><Action c={c} label="email.cancelRemoval" onPress={closeEmail} disabled={busy}/></>}
        {emailView.kind==='removal_stale' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.removalStale')}</Text><Action c={c} label="email.closeRemoval" onPress={closeEmail} disabled={busy}/></>}
        {emailView.kind==='removed' && <><Text style={[styles.text,{color:c.texteSecondaire}]}>{t('email.removed')}</Text><Action c={c} label="email.done" onPress={closeEmail} disabled={busy}/></>}
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
