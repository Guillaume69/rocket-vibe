import {useCallback,useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Alert,StyleSheet,Text,View} from 'react-native';
import {useRouter} from 'expo-router';
import type {NativeChat} from '../fournisseurs/rocketvibe/chat.ts';
import type {DeviceSession} from '../fournisseurs/rocketvibe/protocol.generated.ts';
import {NativeError} from '../fournisseurs/rocketvibe/transport.ts';
import {useSynchro} from './synchro.tsx';
import {useT} from './i18n.ts';
import {Appuyable} from './appuyable.tsx';
import {ChampPilule} from './kit.tsx';
import {POLICES,type Couleurs} from './theme.ts';

// Object identity scopes retained alerts to one provider, without putting a
// credential in a React key or re-mounting the form on every reconnect.
const providerKeys=new WeakMap<NativeChat,number>();let nextProviderKey=0;
function providerKey(chat:NativeChat):number {
  const known=providerKeys.get(chat);if(known!==undefined)return known;
  const key=++nextProviderKey;providerKeys.set(chat,key);return key;
}
export function SectionAppareils({c}:{c:Couleurs}) {
  const sync=useSynchro();
  const chat=sync.phase==='pret'?sync.fournisseur.native?.chat:null;
  return chat?.capabilities?.device_sessions ? <Appareils key={providerKey(chat)} c={c} chat={chat}/> : null;
}

function Appareils({c,chat}:{c:Couleurs;chat:NativeChat}) {
  const t=useT();const router=useRouter();
  const [devices,setDevices]=useState<DeviceSession[]>([]);
  const [labels,setLabels]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);const [error,setError]=useState<'devices.failed'|'devices.reauth'|null>(null);
  const alive=useRef(true);const inFlight=useRef(false);
  const run=useCallback(async(action:()=>Promise<void>)=>{
    if(!alive.current || inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(null);
    try {
      await action();if(!alive.current)return;
      const next=await chat.deviceSessions();if(!alive.current)return;
      setDevices(next);setLabels(Object.fromEntries(next.map(d=>[d.id,d.label])));
    } catch(e) {
      if(alive.current)setError(e instanceof NativeError && e.code==='reauthentication_required'?'devices.reauth':'devices.failed');
    } finally {inFlight.current=false;if(alive.current)setBusy(false);}
  },[chat]);
  useEffect(()=>{alive.current=true;void run(async()=>{});return()=>{alive.current=false;};},[run]);
  const revoke=(device:DeviceSession)=>Alert.alert(t('devices.confirm'),t('devices.confirmBody'),[
    {text:t('commun.annuler'),style:'cancel'},
    {text:t('devices.revoke'),style:'destructive',onPress:()=>{if(!device.current)void run(()=>chat.revokeDevice(device.id));}},
  ]);
  const date=(value:string)=>{const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString():value;};
  return <>
    <Text style={[styles.heading,{color:c.attenue}]}>{t('devices.title')}</Text>
    <View style={[styles.card,{backgroundColor:c.carteProfonde,borderColor:c.bordure}]}>
      {busy && <ActivityIndicator color={c.accent}/>}
      {devices.map(device=><View key={device.id} style={[styles.device,{borderColor:c.bordureDouce}]}>
        <Text style={[styles.title,{color:c.texte}]}>{device.label || t('devices.unnamed')}</Text>
        {device.current && <Text style={[styles.text,{color:c.attenue}]}>{t('devices.current')}</Text>}
        <ChampPilule c={c} etiquette={t('devices.name')} valeur={labels[device.id]??device.label} editable={!busy} maxLength={128} onChangeText={label=>setLabels(previous=>({...previous,[device.id]:label}))}/>
        <Appuyable disabled={busy || !(labels[device.id]??'').trim() || labels[device.id]===device.label} accessibilityRole="button" onPress={()=>void run(()=>chat.renameDevice(device.id,labels[device.id]??device.label))}>
          <Text style={[styles.action,{color:c.cyan}]}>{t('commun.enregistrer')}</Text>
        </Appuyable>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('devices.created')} : {date(device.created_at)}</Text>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('devices.seen')} : {date(device.last_seen_at)}</Text>
        <Text style={[styles.text,{color:c.texteSecondaire}]}>{t('devices.expires')} : {date(device.expires_at)}</Text>
        {!device.current && <Appuyable disabled={busy} accessibilityRole="button" onPress={()=>revoke(device)}><Text style={[styles.action,{color:c.texteErreur}]}>{t('devices.revoke')}</Text></Appuyable>}
      </View>)}
      {error && <Text accessibilityRole="alert" style={[styles.text,{color:c.texteErreur}]}>{t(error)}</Text>}
      {error==='devices.reauth' && <Appuyable accessibilityRole="button" onPress={()=>router.push('/connexion?changer=1')}><Text style={[styles.action,{color:c.cyan}]}>{t('devices.reauth')}</Text></Appuyable>}
      <Appuyable accessibilityRole="button" disabled={busy} onPress={()=>void run(async()=>{})}><Text style={[styles.action,{color:c.cyan}]}>{t('devices.refresh')}</Text></Appuyable>
    </View>
  </>;
}
const styles=StyleSheet.create({
  heading:{fontFamily:POLICES.corpsFort,fontSize:11,textTransform:'uppercase',letterSpacing:0.6,marginTop:8,marginLeft:4},
  card:{borderRadius:16,borderWidth:1,padding:16,gap:10},
  device:{gap:10,paddingVertical:12,borderBottomWidth:StyleSheet.hairlineWidth},
  title:{fontFamily:POLICES.titre,fontSize:16},text:{fontFamily:POLICES.corps,fontSize:13,lineHeight:18},
  action:{fontFamily:POLICES.corpsGras,fontSize:13,paddingVertical:8},
});
