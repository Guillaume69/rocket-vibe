import {useCallback,useEffect,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {CryptoNative,type CryptoIdentityApproval,type CryptoIdentityStatus} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {CryptoIdentityAccess} from '../fournisseurs/rocketvibe/cryptoIdentity.ts';
import type {WithdrawalDevice,WithdrawalPreview,WithdrawalStatus} from '../fournisseurs/rocketvibe/cryptoWithdrawals.ts';
import {NativeError} from '../fournisseurs/rocketvibe/transport.ts';
import {useSynchro} from './synchro.tsx';
import {useT} from './i18n.ts';
import {Appuyable} from './appuyable.tsx';
import {ChampPilule} from './kit.tsx';
import {POLICES,type Couleurs} from './theme.ts';
import type {CleTraduction} from './messages.ts';

const keys=new WeakMap<NativeChat,number>();let nextKey=0;
function key(chat:NativeChat):number {let k=keys.get(chat);if(k===undefined){k=++nextKey;keys.set(chat,k);}return k;}
const labels={missing:'private.missing',identity_created:'private.created',waiting_for_approval:'private.waiting',
  registering:'private.registering',ready:'private.ready',expired:'private.expired',renewing:'private.renewing'} as const;
export function SectionIdentiteChiffree({c}:{c:Couleurs}) {
  const sync=useSynchro(),chat=sync.phase==='pret'?sync.fournisseur.native?.chat:null;
  return CryptoNative && chat?.capabilities?.e2ee && chat.capabilities.device_sessions
    ? <Identite key={key(chat)} c={c} chat={chat}/> : null;
}
function ActionIdentite({c,label,onPress,busy,disabled=false}:{c:Couleurs;label:CleTraduction;onPress:()=>void;busy:boolean;disabled?:boolean}) {
  const t=useT();
  return <Appuyable disabled={busy||disabled} accessibilityRole="button" onPress={onPress}>
    <Text style={[styles.action,{color:c.cyan}]}>{t(label)}</Text>
  </Appuyable>;
}
function Identite({c,chat}:{c:Couleurs;chat:NativeChat}) {
  const t=useT();
  const [view,setView]=useState<CryptoIdentityStatus|null>(null),[preview,setPreview]=useState<CryptoIdentityApproval|null>(null);
  const [root,setRoot]=useState(''),[request,setRequest]=useState(''),[grant,setGrant]=useState('');
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const [reauth,setReauth]=useState(false);
  const [withdrawals,setWithdrawals]=useState<WithdrawalStatus|null>(null),[withdrawalPreview,setWithdrawalPreview]=useState<WithdrawalPreview|null>(null);
  const focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null),access=useRef<CryptoIdentityAccess|null>(null);
  const clear=useCallback(()=>{epoch.current++;job.current=null;void access.current?.close();access.current=null;
    setView(null);setPreview(null);setWithdrawals(null);setWithdrawalPreview(null);setRoot('');setRequest('');setGrant('');setBusy(false);setFailed(false);setReauth(false);},[]);
  const run=useCallback(async(action:(a:CryptoIdentityAccess)=>Promise<void>)=>{
    if(!focused.current || job.current!==null || AppState.currentState!=='active' || !CryptoNative)return;
    const n=epoch.current,visible=()=>focused.current && epoch.current===n && AppState.currentState==='active';
    job.current=n;setBusy(true);setFailed(false);setReauth(false);setWithdrawalPreview(null);
    try {
      if(access.current?.isClosed){void access.current.close();access.current=null;}
      const a=access.current??await chat.cryptoIdentity(CryptoNative,visible);
      if(!visible()){void a.close();return;}access.current=a;
      await action(a);if(!visible())return;
      const latest=await a.view();if(visible())setView(latest);
      const withdrawn=latest.phase==='ready' || latest.phase==='expired' ? await chat.cryptoWithdrawals(a,CryptoNative).view() : null;
      if(visible())setWithdrawals(withdrawn);
    } catch(error) {
      if(visible()){
        setFailed(true);setPreview(null);setWithdrawalPreview(null);
        setReauth(error instanceof NativeError && error.code==='reauthentication_required');
        // A lost registration response keeps the original intention in Rust.
        // Refresh exposes its retry action without making another HTTP mutation.
        try {
          const a=access.current,latest=await a?.view();if(visible() && latest)setView(latest);
          const withdrawn=a && latest && (latest.phase==='ready' || latest.phase==='expired') ? await chat.cryptoWithdrawals(a,CryptoNative).view() : null;
          if(visible())setWithdrawals(withdrawn);
        } catch {if(visible()){setView(null);setWithdrawals(null);}}
      }
    } finally {if(job.current===n){job.current=null;if(visible())setBusy(false);}}
  },[chat]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();void run(async()=>{});
    return()=>{focused.current=false;clear();};},[clear,run]));
  useEffect(()=>{const subscription=AppState.addEventListener('change',state=>{
    if(state!=='active')clear();else if(focused.current)void run(async()=>{});
  });return()=>subscription.remove();},[clear,run]);
  const begin=()=>{const n=epoch.current,expected=root.trim();Alert.alert(t('private.begin'),t('private.beginBody'),[
    {text:t('commun.annuler'),style:'cancel'},
    {text:t('private.begin'),onPress:()=>{if(focused.current && epoch.current===n)void run(async a=>{setView(await a.begin(expected));});}},
  ]);};
  const inspect=(code:string)=>{setPreview(null);setGrant('');void run(async a=>{const result=await a.preview(code);if(focused.current)setPreview(result);});};
  const approve=()=>{const selected=preview;if(!selected)return;setPreview(null);
    void run(async a=>{const result=await a.approve(selected.id);if(focused.current)setGrant(result);});};
  const copy=(value:string)=>{if(focused.current && AppState.currentState==='active')void Clipboard.setStringAsync(value);};
  const inspectWithdrawal=(device:WithdrawalDevice)=>{
    const n=epoch.current;setWithdrawalPreview(null);
    void run(async a=>{if(!CryptoNative)return;const inspected=await chat.cryptoWithdrawals(a,CryptoNative).preview(device);
      if(focused.current && epoch.current===n)setWithdrawalPreview(inspected);});
  };
  const confirmWithdrawal=()=>{
    const selected=withdrawalPreview,n=epoch.current;if(!selected)return;
    Alert.alert(t('private.withdrawalConfirm'),`${t('private.withdrawalBody')}\n\n${selected.device}\n${selected.fingerprint}\n${selected.incarnation}`, [
      {text:t('commun.annuler'),style:'cancel'},
      {text:t('private.withdrawalConfirm'),style:'destructive',onPress:()=>{
        if(!focused.current || epoch.current!==n)return;setWithdrawalPreview(null);
        void run(async a=>{if(CryptoNative)await chat.cryptoWithdrawals(a,CryptoNative).confirm(selected.id);});
      }},
    ]);
  };
  const fingerprint=(label:CleTraduction,value:string)=><>
    <Text style={[styles.text,{color:c.texteSecondaire}]}>{t(label)}</Text>
    <Text selectable style={[styles.fingerprint,{color:c.texte}]}>{value}</Text>
  </>;
  return <>
    <Text style={[styles.heading,{color:c.attenue}]}>{t('private.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.carteProfonde,borderColor:c.bordure}]}>
      <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.experimental')}</Text>
      {busy && <ActivityIndicator color={c.accent}/>}
      {view && <Text style={[styles.title,{color:c.texte}]}>{t(labels[view.phase])}</Text>}
      {view?.certificateExpiresAt && <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.expires')} : {new Date(Number(view.certificateExpiresAt)*1000).toLocaleString()}</Text>}
      {view?.rootFingerprint && fingerprint('private.fingerprint',view.rootFingerprint)}
      {(view?.phase==='ready' || view?.phase==='expired' || view?.phase==='renewing') &&
        <ActionIdentite c={c} busy={busy} label="private.renew" onPress={()=>{const expected=view.rootFingerprint;setPreview(null);setGrant('');
          void run(async a=>{setView(await a.renew(expected));});}} disabled={!!withdrawals?.pending}/>}
      {view?.phase==='missing' && <>
        {view.remoteFingerprint && <>
          {fingerprint('private.remoteFingerprint',view.remoteFingerprint)}
          <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.compare')}</Text>
          <ChampPilule c={c} etiquette={t('private.comparedFingerprint')} valeur={root} onChangeText={setRoot} editable={!busy} maxLength={64} autoCapitalize="none" autoCorrect={false}/>
        </>}
        <ActionIdentite c={c} busy={busy} label="private.begin" onPress={begin} disabled={!!view.remoteFingerprint && root.trim()!==view.remoteFingerprint}/>
      </>}
      {view?.requestCode && <>
        {fingerprint('private.requestFingerprint',view.requestFingerprint)}
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.transferRequest')}</Text>
        <ActionIdentite c={c} busy={busy} label="private.copyRequest" onPress={()=>copy(view.requestCode)}/>
        {view.controlsRoot && (view.phase==='identity_created' || view.phase==='renewing') && <ActionIdentite c={c} busy={busy} label="private.selfPreview" onPress={()=>inspect(view.requestCode)}/>}
      </>}
      {view?.controlsRoot && view.phase!=='registering' && <>
        <ChampPilule c={c} etiquette={t('private.request')} valeur={request} onChangeText={value=>{setRequest(value);setPreview(null);setGrant('');}} editable={!busy} multiline maxLength={5500} autoCapitalize="none" autoCorrect={false}/>
        <ActionIdentite c={c} busy={busy} label="private.preview" onPress={()=>inspect(request.trim())} disabled={!request.trim()}/>
      </>}
      {preview && <>
        {fingerprint('private.fingerprint',preview.rootFingerprint)}
        {fingerprint('private.requestFingerprint',preview.requestFingerprint)}
        <Text selectable style={[styles.text,{color:c.texte}]}>{t('private.device')} : {preview.device}</Text>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.approveBody')}</Text>
        <ActionIdentite c={c} busy={busy} label="private.approve" onPress={approve}/>
      </>}
      {grant && <>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.transferGrant')}</Text>
        <ActionIdentite c={c} busy={busy} label="private.copyGrant" onPress={()=>copy(grant)}/>
      </>}
      {(view?.phase==='waiting_for_approval' || view?.phase==='identity_created' || view?.phase==='renewing') && <>
        <ChampPilule c={c} etiquette={t('private.grant')} valeur={grant} onChangeText={setGrant} editable={!busy} multiline maxLength={11000} autoCapitalize="none" autoCorrect={false}/>
        <ActionIdentite c={c} busy={busy} label="private.install" onPress={()=>{const code=grant.trim();setGrant('');void run(async a=>{setView(await a.install(code));});}} disabled={!grant.trim()}/>
      </>}
      {view?.phase==='registering' && <ActionIdentite c={c} busy={busy} label="private.resume" onPress={()=>void run(async a=>{setView(await a.resume());})}/>}
      {view?.phase==='ready' && <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.readyBody')}</Text>}
      {withdrawals && <>
        <Text style={[styles.title,{color:c.texte}]}>{t('private.withdrawalTitle')}</Text>
        {!withdrawals.controls_root && <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.withdrawalRootOnly')}</Text>}
        {withdrawals.devices.map(device=><View key={`${device.device}:${device.incarnation}`}>
          <Text selectable style={[styles.text,{color:c.texte}]}>{device.device}</Text>
          <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('private.expires')} : {new Date(Number(device.expires_at)*1000).toLocaleString()}</Text>
          {withdrawals.controls_root && <ActionIdentite c={c} busy={busy} label="private.withdrawalInspect" onPress={()=>inspectWithdrawal(device)} disabled={!!withdrawals.pending}/>}
        </View>)}
        {withdrawalPreview && <>
          {fingerprint('private.fingerprint',withdrawalPreview.fingerprint)}
          <Text selectable style={[styles.text,{color:c.texte}]}>{withdrawalPreview.device}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.texteSecondaire}]}>{t('private.incarnation')} : {withdrawalPreview.incarnation}</Text>
          <ActionIdentite c={c} busy={busy} label="private.withdrawalConfirm" onPress={confirmWithdrawal}/>
        </>}
        {withdrawals.pending && <>
          <Text accessibilityRole="alert" style={[styles.text,{color:c.texteSecondaire}]}>{t('private.withdrawalPending')} : {withdrawals.pending.device}</Text>
          <ActionIdentite c={c} busy={busy} label="private.withdrawalResume" onPress={()=>void run(async a=>{if(CryptoNative)await chat.cryptoWithdrawals(a,CryptoNative).resume();})}/>
        </>}
        {withdrawals.withdrawn.map(device=><Text key={`${device.device}:${device.incarnation}`} selectable style={[styles.text,{color:c.texteSecondaire}]}>{t('private.withdrawn')} : {device.device} · {device.incarnation}</Text>)}
      </>}
      {failed && <Text accessibilityRole="alert" style={[styles.text,{color:c.texteErreur}]}>{t(reauth?'devices.reauth':'private.failed')}</Text>}
      <ActionIdentite c={c} busy={busy} label="devices.refresh" onPress={()=>void run(async()=>{})}/>
    </View>
  </>;
}
const styles=StyleSheet.create({
  heading:{fontFamily:POLICES.corpsFort,fontSize:11,textTransform:'uppercase',letterSpacing:0.6,marginTop:8,marginLeft:4},
  card:{borderRadius:16,borderWidth:1,padding:16,gap:10},title:{fontFamily:POLICES.titre,fontSize:16},
  text:{fontFamily:POLICES.corps,fontSize:13,lineHeight:18},fingerprint:{fontFamily:POLICES.corps,fontSize:12,lineHeight:18},
  action:{fontFamily:POLICES.corpsGras,fontSize:13,paddingVertical:8},
});
