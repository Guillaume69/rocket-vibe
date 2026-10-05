/** Controls inside the existing information sheet; providers own commands and receipts. */
import {eq} from 'drizzle-orm';
import {useEffect,useRef,useState} from 'react';
import {Alert,StyleSheet,Switch,Text,TextInput,View} from 'react-native';
import type {LocalDatabase} from '../db/client.ts';
import {nativeRoomOperations} from '../db/schema.ts';
import type {RoomFields,RoomManagement,RoomIntent,ProviderRoomMemberPage,RoomSettings,RoomRole} from '../lib/provider.ts';
import {describeProviderError} from '../lib/providerError.ts';
import {Tappable} from './tappable.tsx';
import {useT} from './i18n.ts';
import {useCoalescedLiveQuery} from './liveQuery.ts';
import {FONTS,type Colors} from './theme.ts';
import type {TranslationKey} from './messages.ts';

const errors:Record<string,TranslationKey>={last_room_owner:'roomManagement.lastOwner',revision_conflict:'roomManagement.conflict',room_action_pending:'roomManagement.pending',room_action_failed:'roomManagement.rejected',rate_limited:'roomManagement.rateLimited',offline:'roomManagement.offline',delivery_revalidate:'roomManagement.refresh',invalid_room_receipt:'roomManagement.refresh',unsupported_feature:'roomManagement.unavailable'};
const roleKey:Record<RoomRole,TranslationKey>={owner:'roomManagement.owner',moderator:'roomManagement.moderator',member:'roomManagement.member'};
function fields(details:RoomSettings):RoomFields{return {name:details.name,isPrivate:details.isPrivate,topic:details.topic,description:details.description,announcement:details.announcement,readOnly:details.readOnly};}

export function RoomCommands({rid,base,details,actions,c,refresh}:{rid:string;base:LocalDatabase;details:RoomSettings;actions:RoomManagement;c:Colors;refresh:()=>void}){
  const t=useT(),alive=useRef(true),locked=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<TranslationKey|null>(null);
  const [edit,setEdit]=useState<{revision:string;fields:RoomFields}|null>(null);
  const [page,setPage]=useState<ProviderRoomMemberPage|null>(null);
  const [saved,setSaved]=useState<{key:string;value:RoomIntent|null}|null>(null);
  const {data:rows}=useCoalescedLiveQuery(base.select({id:nativeRoomOperations.id,state:nativeRoomOperations.state,error:nativeRoomOperations.error}).from(nativeRoomOperations).where(eq(nativeRoomOperations.rid,rid)),[rid]);
  const stateKey=JSON.stringify(rows??[]),intent=saved?.key===stateKey?saved.value:null;
  const members=page?.revision===details.revision?page:null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{let active=true;void actions.intention(rid).then(value=>{if(active)setSaved({key:stateKey,value});}).catch(()=>{if(active)setError('roomManagement.failed');});return()=>{active=false;};},[actions,rid,stateKey]);
  const run=async(fn:()=>Promise<void>,shouldRefresh=true)=>{
    if(locked.current || !alive.current)return;
    locked.current=true;setBusy(true);setError(null);
    try{await fn();}
    catch(error){if(alive.current)setError(errors[describeProviderError(error,true).code]??'roomManagement.failed');}
    finally{locked.current=false;if(alive.current){setBusy(false);if(shouldRefresh)refresh();}}
  };
  const button=(title:string,action:()=>void,disabled=false)=> <Tappable key={title} accessibilityRole="button" accessibilityState={{disabled:busy||disabled}} disabled={busy||disabled} onPress={action} style={[styles.button,{backgroundColor:c.card,opacity:busy||disabled?0.5:1}]}><Text style={[styles.buttonText,{color:c.text}]}>{title}</Text></Tappable>;
  const change=<K extends keyof RoomFields>(key:K,value:RoomFields[K])=>setEdit(current=>current?{...current,fields:{...current.fields,[key]:value}}:null);
  const input=(key:'name'|'topic'|'description'|'announcement',label:string,multiline=false)=> <View key={key} style={styles.field}><Text style={{color:c.dimmed}}>{label}</Text><TextInput accessibilityLabel={label} editable={!busy} value={edit?.fields[key]??''} onChangeText={value=>change(key,value)} multiline={multiline} style={[styles.input,{backgroundColor:c.card,color:c.text,minHeight:multiline?80:44}]} /></View>;
  const loadMembers=(next:boolean)=>void run(async()=>{
    const fresh=await actions.members(rid,next?members?.continuation??null:null,details.revision);
    if(alive.current)setPage(next && members?{...fresh,members:[...members.members,...fresh.members]}:fresh);
  },false);
  return <View style={styles.root}>
    {error && <Text accessibilityRole="alert" style={{color:c.errorText}}>{t(error)}</Text>}
    {intent && <View style={[styles.saved,{backgroundColor:c.deepCard}]}>
      <Text style={{color:c.text}}>{t(intent.failed?'roomManagement.rejected':'roomManagement.pending')}</Text>
      {intent.error && <Text style={{color:c.errorText}}>{t(errors[intent.error]??'roomManagement.failed')}</Text>}
      {!intent.failed?button(t('roomManagement.resume'),()=>void run(()=>actions.resume(rid))):<>
        {intent.settings && details.canEdit && button(t('roomManagement.review'),()=>void run(async()=>{
          if(await actions.clear(rid,intent.key) && alive.current)setEdit({revision:details.revision,fields:intent.settings!});
        }))}
        {button(t('roomManagement.clear'),()=>void run(async()=>{await actions.clear(rid,intent.key);}))}
      </>}
    </View>}
    {edit?<View style={styles.fields}>
      <Text style={{color:c.dimmed}}>{t('roomManagement.formRevision')}</Text>
      {input('name',t('native.roomName'))}{input('topic',t('roomInfo.topic'),true)}{input('description',t('roomInfo.description'),true)}{input('announcement',t('roomInfo.announcement'),true)}
      <View style={styles.toggle}><Text style={{color:c.text}}>{t('native.private')}</Text><Switch accessibilityLabel={t('native.private')} disabled={busy} value={edit.fields.isPrivate} onValueChange={value=>change('isPrivate',value)} /></View>
      <View style={styles.toggle}><Text style={{color:c.text}}>{t('roomInfo.readOnly')}</Text><Switch accessibilityLabel={t('roomInfo.readOnly')} disabled={busy} value={edit.fields.readOnly} onValueChange={value=>change('readOnly',value)} /></View>
      {button(t('common.save'),()=>void run(async()=>{await actions.edit(rid,edit.revision,edit.fields);if(alive.current)setEdit(null);}),!!intent||!details.canEdit)}
      {button(t('common.cancel'),()=>setEdit(null))}
    </View>:details.canEdit && button(t('roomManagement.edit'),()=>setEdit({revision:details.revision,fields:fields(details)}),!!intent)}
    {button(t('roomManagement.members'),()=>loadMembers(false))}
    {members?.members.map(member=><View key={member.id} style={[styles.member,{borderColor:c.softBorder}]}>
      <Text style={{color:c.text}}>{member.name||member.username} · @{member.username}</Text>
      <Text style={{color:c.dimmed}}>{t(roleKey[member.role])}{member.deactivated?' · '+t('roomManagement.deactivated'):''}</Text>
      {details.canChangeRoles && <View style={styles.roles}>{(['member','moderator','owner'] as const).map(role=>button(t(roleKey[role]),()=>void run(()=>actions.changeRole(rid,members.revision,member.id,role)),member.deactivated||member.role===role||!!intent))}</View>}
    </View>)}
    {members?.continuation && button(t('roomManagement.moreMembers'),()=>loadMembers(true))}
    {details.canLeave && button(t('roomManagement.leave'),()=>Alert.alert(t('roomManagement.leave'),t('roomManagement.confirmLeave'),[{text:t('common.cancel'),style:'cancel'},{text:t('roomManagement.leave'),style:'destructive',onPress:()=>void run(()=>actions.leave(rid,details.revision))}]),!!intent)}
  </View>;
}
const styles=StyleSheet.create({root:{gap:12,marginTop:12},fields:{gap:10},field:{gap:6},input:{borderRadius:12,padding:12,fontFamily:FONTS.body,fontSize:15,textAlignVertical:'top'},toggle:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12},button:{padding:12,borderRadius:12},buttonText:{fontFamily:FONTS.body,fontSize:15},saved:{padding:12,borderRadius:12,gap:8},member:{gap:6,paddingVertical:10,borderBottomWidth:1},roles:{flexDirection:'row',flexWrap:'wrap',gap:6}});
