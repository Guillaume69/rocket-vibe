import {useCallback,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {ActivityIndicator,Alert,StyleSheet,Text,View} from 'react-native';
import {dismissible} from './alerts.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';
import type {DeviceSession} from '../providers/rocketvibe/protocol.generated.ts';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {useSync} from './sync.tsx';
import {useT} from './i18n.ts';
import {Tappable} from './tappable.tsx';
import {PillField} from './kit.tsx';
import {FONTS,type Colors} from './theme.ts';
import {ConfirmNativeIdentity} from './nativeSecurity.tsx';

// Object identity scopes retained alerts to one provider, without putting a
// credential in a React key or re-mounting the form on every reconnect.
const providerKeys=new WeakMap<NativeChat,number>();let nextProviderKey=0;
function providerKey(chat:NativeChat):number {
  const known=providerKeys.get(chat);if(known!==undefined)return known;
  const key=++nextProviderKey;providerKeys.set(chat,key);return key;
}
/** The server lists device sessions (also what shows the settings category). */
export function hasDevices(chat:NativeChat|null|undefined):boolean {
  return !!chat?.capabilities?.device_sessions;
}
export function DevicesSection({c}:{c:Colors}) {
  const sync=useSync();
  const chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  return chat && hasDevices(chat) ? <Devices key={providerKey(chat)} c={c} chat={chat}/> : null;
}

function Devices({c,chat}:{c:Colors;chat:NativeChat}) {
  const t=useT();
  const [confirming,setConfirming]=useState(false);
  const [devices,setDevices]=useState<DeviceSession[]>([]);
  const [labels,setLabels]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);const [error,setError]=useState<'devices.failed'|'devices.reauth'|null>(null);
  const alive=useRef(false);const epoch=useRef(0);const inFlight=useRef<number|null>(null);
  const run=useCallback(async(action:()=>Promise<void>)=>{
    if(!alive.current || inFlight.current!==null)return;
    const n=epoch.current,visible=()=>alive.current && epoch.current===n;
    inFlight.current=n;setBusy(true);setError(null);
    try {
      await action();if(!visible())return;
      const next=await chat.deviceSessions();if(!visible())return;
      setDevices(next);setLabels(Object.fromEntries(next.map(d=>[d.id,d.label])));
    } catch(e) {
      if(visible())setError(e instanceof NativeError && e.code==='reauthentication_required'?'devices.reauth':'devices.failed');
    } finally {if(inFlight.current===n){inFlight.current=null;if(visible())setBusy(false);}}
  },[chat]);
  useFocusEffect(useCallback(()=>{alive.current=true;epoch.current++;inFlight.current=null;queueMicrotask(()=>{if(alive.current)void run(async()=>{});});return()=>{alive.current=false;epoch.current++;};},[run]));
  const revoke=(device:DeviceSession)=>{const n=epoch.current;Alert.alert(t('devices.confirm'),t('devices.confirmBody'),[
    {text:t('common.cancel'),style:'cancel'},
    {text:t('devices.revoke'),style:'destructive',onPress:()=>{if(!device.current && alive.current && epoch.current===n)void run(()=>chat.revokeDevice(device.id));}},
  ],dismissible());};
  const date=(value:string)=>{const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString():value;};
  return <>
    <Text style={[styles.heading,{color:c.dimmed}]}>{t('devices.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.deepCard,borderColor:c.border}]}>
      {busy && <ActivityIndicator color={c.accent}/>}
      {devices.map(device=><View key={device.id} style={[styles.device,{borderColor:c.softBorder}]}>
        <Text style={[styles.title,{color:c.text}]}>{device.label || t('devices.unnamed')}</Text>
        {device.current && <Text style={[styles.text,{color:c.dimmed}]}>{t('devices.current')}</Text>}
        <PillField c={c} label={t('devices.name')} value={labels[device.id]??device.label} editable={!busy} maxLength={128} onChangeText={label=>setLabels(previous=>({...previous,[device.id]:label}))}/>
        <Tappable disabled={busy || !(labels[device.id]??'').trim() || labels[device.id]===device.label} accessibilityRole="button" onPress={()=>void run(()=>chat.renameDevice(device.id,labels[device.id]??device.label))}>
          <Text style={[styles.action,{color:c.cyan}]}>{t('common.save')}</Text>
        </Tappable>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('devices.created')} : {date(device.created_at)}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('devices.seen')} : {date(device.last_seen_at)}</Text>
        <Text style={[styles.text,{color:c.secondaryText}]}>{t('devices.expires')} : {date(device.expires_at)}</Text>
        {!device.current && <Tappable disabled={busy} accessibilityRole="button" onPress={()=>revoke(device)}><Text style={[styles.action,{color:c.errorText}]}>{t('devices.revoke')}</Text></Tappable>}
      </View>)}
      {error && <Text accessibilityRole="alert" style={[styles.text,{color:c.errorText}]}>{t(error)}</Text>}
      {error==='devices.reauth' && chat.capabilities?.reauthentication_retirement && <Tappable accessibilityRole="button" onPress={()=>setConfirming(true)}><Text style={[styles.action,{color:c.cyan}]}>{t('security.verify')}</Text></Tappable>}
      {confirming && <ConfirmNativeIdentity c={c} chat={chat} onConfirmed={()=>{if(alive.current){setConfirming(false);void run(async()=>{});}}}/>}
      <Tappable accessibilityRole="button" disabled={busy} onPress={()=>void run(async()=>{})}><Text style={[styles.action,{color:c.cyan}]}>{t('devices.refresh')}</Text></Tappable>
    </View>
  </>;
}
const styles=StyleSheet.create({
  heading:{fontFamily:FONTS.bodyStrong,fontSize:11,textTransform:'uppercase',letterSpacing:0.6,marginTop:8,marginLeft:4},
  card:{borderRadius:16,borderWidth:1,padding:16,gap:10},
  device:{gap:10,paddingVertical:12,borderBottomWidth:StyleSheet.hairlineWidth},
  title:{fontFamily:FONTS.title,fontSize:16},text:{fontFamily:FONTS.body,fontSize:13,lineHeight:18},
  action:{fontFamily:FONTS.bodyBold,fontSize:13,paddingVertical:8},
});
