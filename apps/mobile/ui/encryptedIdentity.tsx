import {useCallback,useEffect,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,AppState,StyleSheet,Text,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {CryptoNative,type CryptoIdentityApproval,type CryptoIdentityStatus} from '../modules/crypto-native/index.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {CryptoIdentityAccess} from '../providers/rocketvibe/cryptoIdentity.ts';
import type {WithdrawalDevice,WithdrawalPreview,WithdrawalStatus} from '../providers/rocketvibe/cryptoWithdrawals.ts';
import type {BackupStatus,BackupPreview,RestorePreview} from '../providers/rocketvibe/cryptoRecovery.ts';
import type {HistoryOffers,HistoryPreview} from '../providers/rocketvibe/cryptoHistory.ts';
import type {HistoryBackupPreview,HistoryBackupStatus} from '../providers/rocketvibe/cryptoHistoryBackup.ts';
import type {StorageKeyStatus} from '../providers/rocketvibe/cryptoStorageKey.ts';
import {inArray} from 'drizzle-orm';
import {rooms} from '../db/schema.ts';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {useSync} from './sync.tsx';
import {useT} from './i18n.ts';
import {Tappable} from './tappable.tsx';
import {PillField} from './kit.tsx';
import {FONTS,type Colors} from './theme.ts';
import type {TranslationKey} from './messages.ts';

const keys=new WeakMap<NativeChat,number>();let nextKey=0;
function key(chat:NativeChat):number {let k=keys.get(chat);if(k===undefined){k=++nextKey;keys.set(chat,k);}return k;}
const labels={missing:'private.missing',identity_created:'private.created',waiting_for_approval:'private.waiting',
  registering:'private.registering',ready:'private.ready',expired:'private.expired',renewing:'private.renewing'} as const;
export function EncryptedIdentitySection({c}:{c:Colors}) {
  const sync=useSync(),chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  return CryptoNative && chat?.capabilities?.e2ee && chat.capabilities.device_sessions
    ? <Identity key={key(chat)} c={c} chat={chat}/> : null;
}
function IdentityAction({c,label,onPress,busy,disabled=false}:{c:Colors;label:TranslationKey;onPress:()=>void;busy:boolean;disabled?:boolean}) {
  const t=useT();
  return <Tappable disabled={busy||disabled} accessibilityRole="button" onPress={onPress}>
    <Text style={[styles.action,{color:c.cyan}]}>{t(label)}</Text>
  </Tappable>;
}
function Identity({c,chat}:{c:Colors;chat:NativeChat}) {
  const t=useT();
  const [view,setView]=useState<CryptoIdentityStatus|null>(null),[preview,setPreview]=useState<CryptoIdentityApproval|null>(null);
  const [root,setRoot]=useState(''),[request,setRequest]=useState(''),[grant,setGrant]=useState('');
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const [reauth,setReauth]=useState(false);
  const [withdrawals,setWithdrawals]=useState<WithdrawalStatus|null>(null),[withdrawalPreview,setWithdrawalPreview]=useState<WithdrawalPreview|null>(null);
  const [backup,setBackup]=useState<BackupStatus|null>(null),[backupPreview,setBackupPreview]=useState<BackupPreview|null>(null);
  const [recoveryCode,setRecoveryCode]=useState(''),[recoveryInput,setRecoveryInput]=useState(''),[restorePreview,setRestorePreview]=useState<RestorePreview|null>(null);
  const [history,setHistory]=useState<{label:TranslationKey;fingerprint?:string}>({label:'private.historyIdle'});
  const [historyOffers,setHistoryOffers]=useState<HistoryOffers|null>(null),[historyPreview,setHistoryPreview]=useState<HistoryPreview|null>(null);
  const [roomNames,setRoomNames]=useState<Record<string,string>>({});
  const [historyBackup,setHistoryBackup]=useState<HistoryBackupStatus|null>(null),[historyBackupPreview,setHistoryBackupPreview]=useState<HistoryBackupPreview|null>(null);
  const [historyCode,setHistoryCode]=useState(''),[historyJoin,setHistoryJoin]=useState(''),[historyBackupResult,setHistoryBackupResult]=useState('');
  const [storage,setStorage]=useState<StorageKeyStatus|null>(null);
  const sync=useSync(),base=sync.phase==='ready'?sync.base:null;
  const focused=useRef(false),epoch=useRef(0),job=useRef<number|null>(null),access=useRef<CryptoIdentityAccess|null>(null);
  const clear=useCallback(()=>{epoch.current++;job.current=null;void access.current?.close();access.current=null;
    setView(null);setPreview(null);setWithdrawals(null);setWithdrawalPreview(null);setBackup(null);setBackupPreview(null);setRecoveryCode('');setRecoveryInput('');setRestorePreview(null);setRoot('');setRequest('');setGrant('');setBusy(false);setFailed(false);setReauth(false);
    setHistory({label:'private.historyIdle'});setHistoryOffers(null);setHistoryPreview(null);setRoomNames({});
    setHistoryBackup(null);setHistoryBackupPreview(null);setHistoryCode('');setHistoryJoin('');setHistoryBackupResult('');setStorage(null);},[]);
  const run=useCallback(async(action:(a:CryptoIdentityAccess)=>Promise<void>)=>{
    if(!focused.current || job.current!==null || AppState.currentState!=='active' || !CryptoNative)return;
    const n=epoch.current,visible=()=>focused.current && epoch.current===n && AppState.currentState==='active';
    job.current=n;setBusy(true);setFailed(false);setReauth(false);setWithdrawalPreview(null);
    setBackupPreview(null);setRestorePreview(null);setRecoveryCode('');setHistoryOffers(null);setHistoryPreview(null);
    setHistoryBackupPreview(null);setHistoryBackupResult('');
    try {
      if(access.current?.isClosed){void access.current.close();access.current=null;}
      const a=access.current??await chat.cryptoIdentity(CryptoNative,visible);
      if(!visible()){void a.close();return;}access.current=a;
      await action(a);if(!visible())return;
      const latest=await a.view();if(visible())setView(latest);
      const withdrawn=latest.phase==='ready' || latest.phase==='expired' ? await chat.cryptoWithdrawals(a,CryptoNative).view() : null;
      if(visible())setWithdrawals(withdrawn);
      const saved=latest.phase==='ready'||latest.phase==='expired'?await chat.cryptoRecovery(a,CryptoNative).view():null;
      if(visible())setBackup(saved);
      const held=latest.phase==='ready'?await chat.cryptoHistoryBackup(a,CryptoNative).view():null;
      if(visible())setHistoryBackup(held);
      const sealed=latest.phase==='ready'||latest.phase==='expired'?await chat.cryptoStorageKey(a,CryptoNative).view():null;
      if(visible())setStorage(sealed);
    } catch(error) {
      if(visible()){
        setFailed(true);setPreview(null);setWithdrawalPreview(null);setBackupPreview(null);setRestorePreview(null);setRecoveryCode('');setRecoveryInput('');
        setHistoryCode('');setHistoryJoin('');
        setReauth(error instanceof NativeError && error.code==='reauthentication_required');
        // A lost registration response keeps the original intention in Rust.
        // Refresh exposes its retry action without making another HTTP mutation.
        try {
          const a=access.current,latest=await a?.view();if(visible() && latest)setView(latest);
          const withdrawn=a && latest && (latest.phase==='ready' || latest.phase==='expired') ? await chat.cryptoWithdrawals(a,CryptoNative).view() : null;
          if(visible())setWithdrawals(withdrawn);
          const saved=a && latest && (latest.phase==='ready'||latest.phase==='expired')?await chat.cryptoRecovery(a,CryptoNative).view():null;
          if(visible())setBackup(saved);
        } catch {if(visible()){setView(null);setWithdrawals(null);setBackup(null);}}
      }
    } finally {if(job.current===n){job.current=null;if(visible())setBusy(false);}}
  },[chat]);
  useFocusEffect(useCallback(()=>{focused.current=true;clear();void run(async()=>{});
    return()=>{focused.current=false;clear();};},[clear,run]));
  useEffect(()=>{const subscription=AppState.addEventListener('change',state=>{
    if(state!=='active')clear();else if(focused.current)void run(async()=>{});
  });return()=>subscription.remove();},[clear,run]);
  const begin=()=>{const n=epoch.current,expected=root.trim();Alert.alert(t('private.begin'),t('private.beginBody'),[
    {text:t('common.cancel'),style:'cancel'},
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
      {text:t('common.cancel'),style:'cancel'},
      {text:t('private.withdrawalConfirm'),style:'destructive',onPress:()=>{
        if(!focused.current || epoch.current!==n)return;setWithdrawalPreview(null);
        void run(async a=>{if(CryptoNative)await chat.cryptoWithdrawals(a,CryptoNative).confirm(selected.id);});
      }},
    ]);
  };
  const inspectBackup=()=>{const n=epoch.current;void run(async a=>{if(!CryptoNative)return;
    const selected=await chat.cryptoRecovery(a,CryptoNative).previewBackup();if(focused.current && epoch.current===n)setBackupPreview(selected);});};
  const prepareBackup=()=>{const selected=backupPreview,n=epoch.current;if(!selected)return;
    Alert.alert(t('private.backupPrepare'),`${t('private.backupReplaceBody')}\n\n${selected.root_fingerprint}`, [
      {text:t('common.cancel'),style:'cancel'},
      {text:t('private.backupPrepare'),onPress:()=>{if(!focused.current||epoch.current!==n)return;
        void run(async a=>{if(!CryptoNative)return;const r=chat.cryptoRecovery(a,CryptoNative);await r.prepareBackup(selected.id);
          const code=await r.code();if(focused.current&&epoch.current===n)setRecoveryCode(code);});}},
    ]);};
  const showRecoveryCode=()=>{const n=epoch.current;void run(async a=>{if(!CryptoNative)return;const code=await chat.cryptoRecovery(a,CryptoNative).code();if(focused.current&&epoch.current===n)setRecoveryCode(code);});};
  const inspectRestore=()=>{const n=epoch.current,code=recoveryInput.trim(),expected=view?.remoteFingerprint??'';setRecoveryInput('');
    void run(async a=>{if(!CryptoNative)return;const selected=await chat.cryptoRecovery(a,CryptoNative).previewRestore(code,expected);if(focused.current&&epoch.current===n)setRestorePreview(selected);});};
  const restore=()=>{const selected=restorePreview,n=epoch.current;if(!selected)return;
    Alert.alert(t('private.restoreConfirm'),`${t('private.restoreBody')}\n\n${selected.root_fingerprint}`, [
      {text:t('common.cancel'),style:'cancel',onPress:()=>{setRestorePreview(null);void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).clearPreview();});}},
      {text:t('private.restoreConfirm'),onPress:()=>{if(!focused.current||epoch.current!==n)return;void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).restore(selected.id);});}},
    ]);};
  const cancelBackup=()=>{const n=epoch.current;Alert.alert(t('private.backupCancel'),t('private.backupCancelBody'),[
    {text:t('common.cancel'),style:'cancel'},
    {text:t('private.backupCancel'),style:'destructive',onPress:()=>{if(focused.current&&epoch.current===n)void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).cancel();});}},
  ]);};
  const historyRun=(action:(h:ReturnType<NativeChat['cryptoHistory']>,n:number)=>Promise<void>)=>{
    const n=epoch.current;void run(async a=>{if(CryptoNative)await action(chat.cryptoHistory(a,CryptoNative),n);});
  };
  const live=(n:number)=>focused.current&&epoch.current===n;
  const requestHistory=()=>historyRun(async(h,n)=>{const fp=await h.requestHistory();if(live(n))setHistory({label:'private.historyRequested',fingerprint:fp});});
  const importHistory=()=>historyRun(async(h,n)=>{const progress=await h.importHistory();if(!live(n))return;
    setHistory(progress.state==='waiting'?{label:'private.historyWaiting',fingerprint:progress.request}:{label:progress.state==='done'?'private.historyDone':'private.historyIdle'});});
  const historyRequests=()=>historyRun(async(h,n)=>{const offers=await h.offers();if(!live(n))return;
    if(offers.offers.length===0)setHistory({label:'private.historyNoOffers'});else setHistoryOffers(offers);});
  const reviewHistory=(fingerprint:string)=>{const staged=historyOffers;if(!staged)return;
    historyRun(async(h,n)=>{const preview=await h.preview(staged.id,fingerprint);if(!live(n))return;
      const ids=preview.periods.map(p=>p.room);
      const named=base&&ids.length?await base.select({rid:rooms.rid,name:rooms.name,displayName:rooms.displayName}).from(rooms).where(inArray(rooms.rid,ids)):[];
      if(!live(n))return;setRoomNames(Object.fromEntries(named.map(r=>[r.rid,r.displayName??r.name??r.rid])));setHistoryPreview(preview);});};
  const shareHistory=()=>{const selected=historyPreview,n=epoch.current;if(!selected||selected.periods.length===0)return;
    const listed=selected.periods.map(p=>`${roomNames[p.room]??p.room} · ${t('private.historyMessages',{n:Number(p.documents)})}`).join('\n');
    const share=(delegate:boolean)=>()=>{if(!live(n))return;setHistoryPreview(null);
      historyRun(async(h,m)=>{await h.share(selected.id,delegate);if(live(m))setHistory({label:'private.historyShared'});});};
    // The root holder may also hand control over (E2EE_DELEGATION.md).
    const delegation=selected.can_delegate?`\n\n${t('private.historyDelegateBody')}`:'';
    Alert.alert(t('private.historyShare'),`${t('private.historyShareBody')}\n\n${selected.device}\n${selected.fingerprint}\n\n${listed}${delegation}`,[
      {text:t('common.cancel'),style:'cancel'},
      {text:t('private.historyShare'),onPress:share(false)},
      ...(selected.can_delegate?[{text:t('private.historyShareDelegate'),style:'destructive' as const,onPress:share(true)}]:[]),
    ]);};
  const resumeHistory=()=>historyRun(async(h,n)=>{const resumed=await h.resumeShare();if(live(n))setHistory({label:resumed?'private.historyShared':'private.historyIdle'});});
  const backupRun=(action:(b:ReturnType<NativeChat['cryptoHistoryBackup']>,n:number)=>Promise<void>)=>{
    const n=epoch.current;void run(async a=>{if(CryptoNative)await action(chat.cryptoHistoryBackup(a,CryptoNative),n);});
  };
  const renewStorage=()=>{const n=epoch.current;void run(async a=>{if(CryptoNative){const fresh=await chat.cryptoStorageKey(a,CryptoNative).renew();if(live(n))setStorage(fresh);}});};
  const day=(value:string|null)=>value===null?null:new Date(Number(value)*1000).toLocaleDateString();
  const reviewHistoryBackup=()=>backupRun(async(b,n)=>{const preview=await b.preview();if(live(n))setHistoryBackupPreview(preview);});
  const enableHistoryBackup=()=>{const selected=historyBackupPreview,n=epoch.current;if(!selected)return;
    Alert.alert(t('private.historyBackupEnable'),t(selected.generation_revision===null?'private.historyBackupBody':'private.historyBackupReplace'),[
      {text:t('common.cancel'),style:'cancel'},
      {text:t('private.historyBackupEnable'),onPress:()=>{if(!live(n))return;setHistoryBackupPreview(null);
        backupRun(async(b,m)=>{await b.prepare(selected.id);const code=await b.code();if(live(m))setHistoryCode(code);});}},
    ]);};
  const showHistoryCode=()=>backupRun(async(b,n)=>{const code=await b.code();if(live(n))setHistoryCode(code);});
  const joinHistoryBackup=()=>{const code=historyJoin.trim();setHistoryJoin('');backupRun(async b=>{await b.join(code);});};
  const syncHistoryBackup=()=>backupRun(async(b,n)=>{const pages=await b.sync();if(live(n))setHistoryBackupResult(t('private.historyBackupSynced',{n:pages}));});
  const restoreHistoryBackup=()=>backupRun(async(b,n)=>{const records=await b.restore();if(live(n))setHistoryBackupResult(t('private.historyBackupRestored',{n:records}));});
  const fingerprint=(label:TranslationKey,value:string)=><>
    <Text style={[styles.text,{color:c.secondaryText}]}>{t(label)}</Text>
    <Text selectable style={[styles.fingerprint,{color:c.text}]}>{value}</Text>
  </>;
  return <>
    <Text style={[styles.heading,{color:c.dimmed}]}>{t('private.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.deepCard,borderColor:c.border}]}>
      <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.experimental')}</Text>
      {busy && <ActivityIndicator color={c.accent}/>}
      {view && <Text style={[styles.title,{color:c.text}]}>{t(labels[view.phase])}</Text>}
      {view?.certificateExpiresAt && <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.expires')} : {new Date(Number(view.certificateExpiresAt)*1000).toLocaleString()}</Text>}
      {view?.rootFingerprint && fingerprint('private.fingerprint',view.rootFingerprint)}
      {(view?.phase==='ready' || view?.phase==='expired' || view?.phase==='renewing') &&
        <IdentityAction c={c} busy={busy} label="private.renew" onPress={()=>{const expected=view.rootFingerprint;setPreview(null);setGrant('');
          void run(async a=>{setView(await a.renew(expected));});}} disabled={!!withdrawals?.pending||!!backup?.pending}/>}
      {view?.phase==='missing' && <>
        {view.remoteFingerprint && <>
          {fingerprint('private.remoteFingerprint',view.remoteFingerprint)}
          <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.compare')}</Text>
          <PillField c={c} label={t('private.comparedFingerprint')} value={root} onChangeText={setRoot} editable={!busy} maxLength={64} autoCapitalize="none" autoCorrect={false}/>
        </>}
        <IdentityAction c={c} busy={busy} label="private.begin" onPress={begin} disabled={!!view.remoteFingerprint && root.trim()!==view.remoteFingerprint}/>
        {view.remoteFingerprint && <>
          <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.restoreBody')}</Text>
          <PillField c={c} label={t('private.recoveryCode')} value={recoveryInput} onChangeText={setRecoveryInput} editable={!busy} maxLength={100} autoCapitalize="none" autoCorrect={false} secureTextEntry/>
          <IdentityAction c={c} busy={busy} label="private.restoreInspect" onPress={inspectRestore} disabled={recoveryInput.trim().length!==78}/>
          {restorePreview && <>
            {fingerprint('private.fingerprint',restorePreview.root_fingerprint)}
            <IdentityAction c={c} busy={busy} label="private.restoreConfirm" onPress={restore}/>
          </>}
        </>}
      </>}
      {view?.requestCode && <>
        {fingerprint('private.requestFingerprint',view.requestFingerprint)}
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.transferRequest')}</Text>
        <IdentityAction c={c} busy={busy} label="private.copyRequest" onPress={()=>copy(view.requestCode)}/>
        {view.controlsRoot && (view.phase==='identity_created' || view.phase==='renewing') && <IdentityAction c={c} busy={busy} label="private.selfPreview" onPress={()=>inspect(view.requestCode)}/>}
      </>}
      {view?.controlsRoot && view.phase!=='registering' && <>
        <PillField c={c} label={t('private.request')} value={request} onChangeText={value=>{setRequest(value);setPreview(null);setGrant('');}} editable={!busy} multiline maxLength={5500} autoCapitalize="none" autoCorrect={false}/>
        <IdentityAction c={c} busy={busy} label="private.preview" onPress={()=>inspect(request.trim())} disabled={!request.trim()}/>
      </>}
      {preview && <>
        {fingerprint('private.fingerprint',preview.rootFingerprint)}
        {fingerprint('private.requestFingerprint',preview.requestFingerprint)}
        <Text selectable style={[styles.text,{color:c.text}]}>{t('private.device')} : {preview.device}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.approveBody')}</Text>
        <IdentityAction c={c} busy={busy} label="private.approve" onPress={approve}/>
      </>}
      {grant && <>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.transferGrant')}</Text>
        <IdentityAction c={c} busy={busy} label="private.copyGrant" onPress={()=>copy(grant)}/>
      </>}
      {(view?.phase==='waiting_for_approval' || view?.phase==='identity_created' || view?.phase==='renewing') && <>
        <PillField c={c} label={t('private.grant')} value={grant} onChangeText={setGrant} editable={!busy} multiline maxLength={11000} autoCapitalize="none" autoCorrect={false}/>
        <IdentityAction c={c} busy={busy} label="private.install" onPress={()=>{const code=grant.trim();setGrant('');void run(async a=>{setView(await a.install(code));});}} disabled={!grant.trim()}/>
      </>}
      {view?.phase==='registering' && <IdentityAction c={c} busy={busy} label="private.resume" onPress={()=>void run(async a=>{setView(await a.resume());})}/>}
      {view?.phase==='ready' && <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.readyBody')}</Text>}
      {view?.phase==='ready' && <>
        <Text style={[styles.title,{color:c.text}]}>{t('private.historyTitle')}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.historyBody')}</Text>
        <Text accessibilityRole="text" style={[styles.text,{color:c.text}]}>{t(history.label)}</Text>
        {history.fingerprint && <Text selectable style={[styles.fingerprint,{color:c.text}]}>{history.fingerprint}</Text>}
        <IdentityAction c={c} busy={busy} label="private.historyRequest" onPress={requestHistory}/>
        <IdentityAction c={c} busy={busy} label="private.historyImport" onPress={importHistory}/>
        <IdentityAction c={c} busy={busy} label="private.historyOffers" onPress={historyRequests}/>
        <IdentityAction c={c} busy={busy} label="private.historyResume" onPress={resumeHistory}/>
        {historyOffers?.offers.map(offer=><View key={offer.fingerprint}>
          <Text style={[styles.text,{color:c.text}]}>{t('private.historyOffer',{device:offer.device})}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{offer.fingerprint}</Text>
          <IdentityAction c={c} busy={busy} label="private.historyReview" onPress={()=>reviewHistory(offer.fingerprint)}/>
        </View>)}
        {historyPreview && (historyPreview.periods.length===0
          ? <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.historyNothing')}</Text>
          : <>
            {fingerprint('private.requestFingerprint',historyPreview.fingerprint)}
            {historyPreview.periods.map(p=><Text key={p.room} style={[styles.text,{color:c.text}]}>{roomNames[p.room]??p.room} · {t('private.historyMessages',{n:Number(p.documents)})}</Text>)}
            <IdentityAction c={c} busy={busy} label="private.historyShare" onPress={shareHistory}/>
          </>)}
      </>}
      {backup?.controls_root && <>
        <Text style={[styles.title,{color:c.text}]}>{t('private.backupTitle')}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.backupBody')}</Text>
        {backup.receipt && <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.backupRegistered')} · {backup.receipt.backup_revision}</Text>}
        {!backup.pending && <IdentityAction c={c} busy={busy} label="private.backupInspect" onPress={inspectBackup} disabled={!!withdrawals?.pending}/>}
        {backupPreview && <>
          {fingerprint('private.fingerprint',backupPreview.root_fingerprint)}
          <IdentityAction c={c} busy={busy} label="private.backupPrepare" onPress={prepareBackup}/>
        </>}
        {backup.pending && <>
          <Text accessibilityRole="alert" style={[styles.text,{color:c.secondaryText}]}>{t(backup.cancel_requested?'private.backupCancelling':backup.code_saved?'private.backupPending':'private.backupKeepCode')}</Text>
          <IdentityAction c={c} busy={busy} label="private.recoveryShow" onPress={showRecoveryCode}/>
          {recoveryCode && <>
            <Text selectable style={[styles.fingerprint,{color:c.text}]}>{recoveryCode}</Text>
            <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.backupKeepCode')}</Text>
            {!backup.code_saved && <IdentityAction c={c} busy={busy} label="private.backupSaved" onPress={()=>void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).confirmSaved();})}/>}
          </>}
          {(backup.code_saved||backup.cancel_requested) && <IdentityAction c={c} busy={busy} label="private.backupResume" onPress={()=>void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).resume();})}/>}
          <IdentityAction c={c} busy={busy} label="private.backupCancel" onPress={cancelBackup}/>
        </>}
      </>}
      {withdrawals && <>
        <Text style={[styles.title,{color:c.text}]}>{t('private.withdrawalTitle')}</Text>
        {!withdrawals.controls_root && <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.withdrawalRootOnly')}</Text>}
        {withdrawals.devices.map(device=><View key={`${device.device}:${device.incarnation}`}>
          <Text selectable style={[styles.text,{color:c.text}]}>{device.device}</Text>
          <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.expires')} : {new Date(Number(device.expires_at)*1000).toLocaleString()}</Text>
          {withdrawals.controls_root && <IdentityAction c={c} busy={busy} label="private.withdrawalInspect" onPress={()=>inspectWithdrawal(device)} disabled={!!withdrawals.pending}/>}
        </View>)}
        {withdrawalPreview && <>
          {fingerprint('private.fingerprint',withdrawalPreview.fingerprint)}
          <Text selectable style={[styles.text,{color:c.text}]}>{withdrawalPreview.device}</Text>
          <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{t('private.incarnation')} : {withdrawalPreview.incarnation}</Text>
          <IdentityAction c={c} busy={busy} label="private.withdrawalConfirm" onPress={confirmWithdrawal}/>
        </>}
        {withdrawals.pending && <>
          <Text accessibilityRole="alert" style={[styles.text,{color:c.secondaryText}]}>{t('private.withdrawalPending')} : {withdrawals.pending.device}</Text>
          <IdentityAction c={c} busy={busy} label="private.withdrawalResume" onPress={()=>void run(async a=>{if(CryptoNative)await chat.cryptoWithdrawals(a,CryptoNative).resume();})}/>
        </>}
        {withdrawals.withdrawn.map(device=><Text key={`${device.device}:${device.incarnation}`} selectable style={[styles.text,{color:c.secondaryText}]}>{t('private.withdrawn')} : {device.device} · {device.incarnation}</Text>)}
      </>}
      {view?.phase==='ready' && historyBackup && <>
        <Text style={[styles.title,{color:c.text}]}>{t('private.historyBackupTitle')}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.historyBackupBody')}</Text>
        <Text style={[styles.text,{color:c.text}]}>{t(historyBackup.pending?'private.historyBackupPending':historyBackup.holds_key?'private.historyBackupOn':'private.historyBackupOff')}</Text>
        {historyBackup.generation && <Text selectable style={[styles.fingerprint,{color:c.secondaryText}]}>{historyBackup.generation}</Text>}
        {historyBackupResult!=='' && <Text style={[styles.text,{color:c.secondaryText}]}>{historyBackupResult}</Text>}
        {historyBackup.pending ? <>
          <IdentityAction c={c} busy={busy} label="private.historyBackupShowCode" onPress={showHistoryCode}/>
          {historyCode!=='' && <Text selectable style={[styles.fingerprint,{color:c.text}]}>{historyCode}</Text>}
          {!historyBackup.code_saved && <IdentityAction c={c} busy={busy} label="private.historyBackupSaved" disabled={historyCode===''}
            onPress={()=>backupRun(async b=>{await b.confirmSaved();setHistoryCode('');})}/>}
          {(historyBackup.code_saved||historyBackup.cancel_requested) && <IdentityAction c={c} busy={busy} label="private.historyBackupResume" onPress={()=>backupRun(async b=>{await b.resume();})}/>}
          {!historyBackup.cancel_requested && <IdentityAction c={c} busy={busy} label="private.historyBackupCancel" onPress={()=>backupRun(async b=>{await b.cancel();})}/>}
        </> : <>
          <IdentityAction c={c} busy={busy} label={historyBackup.holds_key?'private.historyBackupRotate':'private.historyBackupEnable'} onPress={reviewHistoryBackup}/>
          {historyBackupPreview && <IdentityAction c={c} busy={busy} label="private.historyBackupEnable" onPress={enableHistoryBackup}/>}
          <PillField c={c} label={t('private.historyBackupCode')} value={historyJoin} onChangeText={setHistoryJoin} editable={!busy} maxLength={100} autoCapitalize="none" autoCorrect={false} secureTextEntry/>
          <IdentityAction c={c} busy={busy} label="private.historyBackupJoin" onPress={joinHistoryBackup} disabled={historyJoin.trim().length!==78}/>
          {historyBackup.holds_key && <>
            <IdentityAction c={c} busy={busy} label="private.historyBackupSync" onPress={syncHistoryBackup}/>
            <IdentityAction c={c} busy={busy} label="private.historyBackupRestore" onPress={restoreHistoryBackup}/>
          </>}
        </>}
      </>}
      {(view?.phase==='ready'||view?.phase==='expired') && storage && <>
        <Text style={[styles.title,{color:c.text}]}>{t('private.storageTitle')}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.storageBody')}</Text>
        <Text style={[styles.text,{color:c.text}]}>{storage.rotated_at===null?t('private.storageNever'):t('private.storageRenewed',{date:day(storage.rotated_at)??''})}</Text>
        {storage.due_at!==null && <Text style={[styles.text,{color:c.secondaryText}]}>{t('private.storageDue',{date:day(storage.due_at)??''})}</Text>}
        <IdentityAction c={c} busy={busy} label="private.storageRenew" onPress={renewStorage}/>
      </>}
      {failed && <Text accessibilityRole="alert" style={[styles.text,{color:c.errorText}]}>{t(reauth?'devices.reauth':'private.failed')}</Text>}
      <IdentityAction c={c} busy={busy} label="devices.refresh" onPress={()=>void run(async a=>{if(CryptoNative)await chat.cryptoRecovery(a,CryptoNative).clearPreview();})}/>
    </View>
  </>;
}
const styles=StyleSheet.create({
  heading:{fontFamily:FONTS.bodyStrong,fontSize:11,textTransform:'uppercase',letterSpacing:0.6,marginTop:8,marginLeft:4},
  card:{borderRadius:16,borderWidth:1,padding:16,gap:10},title:{fontFamily:FONTS.title,fontSize:16},
  text:{fontFamily:FONTS.body,fontSize:13,lineHeight:18},fingerprint:{fontFamily:FONTS.body,fontSize:12,lineHeight:18},
  action:{fontFamily:FONTS.bodyBold,fontSize:13,paddingVertical:8},
});
