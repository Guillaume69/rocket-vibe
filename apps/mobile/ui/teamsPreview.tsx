import { useEffect, useRef, useState } from 'react';
import { Pressable,Text,TextInput,View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { TeamsError,messageText,type TeamsConversation,type TeamsMessage } from '../providers/teams/protocol.ts';
import { TeamsReader } from '../providers/teams/reader.ts';
import { Pairing } from '../providers/teams/handoff.ts';
import { useT } from './i18n.ts';
import { useColors } from './theme.ts';
export function TeamsPreview({onHide}:{onHide:()=>void}) {
  const t=useT(),c=useColors();const [pair]=useState(()=>new Pairing());const [key,setKey]=useState(()=>pair.code()),[code,setCode]=useState('');
  const [connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState<string|null>(null);
  const [rooms,setRooms]=useState<TeamsConversation[]>([]),[messages,setMessages]=useState<TeamsMessage[]>([]),[room,setRoom]=useState<TeamsConversation|null>(null),[cursor,setCursor]=useState<string|null>(null);
  const reader=useRef<TeamsReader|null>(null),generation=useRef(0),flight=useRef(false),seen=useRef(new Set<string>());
  useEffect(()=>()=>{generation.current++;reader.current?.close();reader.current=null;pair.close();},[pair]);
  const reset=()=>{generation.current++;reader.current?.close();reader.current=null;setKey(pair.rotate());setCode('');setConnected(false);setRooms([]);setMessages([]);setRoom(null);setCursor(null);seen.current.clear();flight.current=false;setBusy(false);setStatus(null);};
  const run=async(work:()=>Promise<void>)=>{if(flight.current)return;flight.current=true;setBusy(true);setStatus(null);const version=generation.current;try{await work();}catch(e){if(version===generation.current)setStatus(t('teams.failed')+' ('+(e instanceof TeamsError?e.code:'connection_failed')+')');}finally{if(version===generation.current){flight.current=false;setBusy(false);}}};
  const connect=()=>run(async()=>{
    const session=pair.open(code.trim());setKey('');setCode('');const client=new TeamsReader(session.account,session.tokens,fetch,session.expiresAt);reader.current?.close();reader.current=client;
    const version=generation.current;await client.discover();if(version!==generation.current)return;setConnected(true);const found=await client.conversations();if(version===generation.current)setRooms(found);
  });
  const loadRooms=()=>run(async()=>{const client=reader.current;if(!client)return;const version=generation.current;const found=await client.conversations();if(version===generation.current)setRooms(found);});
  const loadRoom=(target:TeamsConversation,more=false)=>run(async()=>{
    const client=reader.current;if(!client)return;const version=generation.current,requested=more?cursor:null;
    if(requested&&seen.current.has(requested))throw new TeamsError('pagination_loop');
    if(!more){setRoom(target);setMessages([]);setCursor(null);seen.current.clear();}
    const page=await client.history(target.id,requested??undefined);if(version!==generation.current)return;if(requested)seen.current.add(requested);
    setMessages(old=>[...new Map([...(more?old:[]),...page.items].map(m=>[m.key,m])).values()]);setCursor(page.backwardLink);
  });
  return <View style={{backgroundColor:c.card,borderRadius:20,padding:18,gap:10,alignSelf:'stretch'}}>
    <Text style={{color:c.text,fontSize:20,fontWeight:'700'}}>{t('teams.title')}</Text><Text style={{color:c.dimmed}}>{t('teams.previewHelp')}</Text>
    {!connected&&<>
      <Text style={{color:c.text}}>{t('teams.key')}</Text><TextInput accessibilityLabel={t('teams.key')} secureTextEntry value={key} editable={false} style={{color:c.text}} />
      <Action label={t('teams.copyKey')} disabled={!key||busy} onPress={()=>{void Clipboard.setStringAsync(key).then(()=>setStatus(t('teams.copied'))).catch(()=>setStatus(t('teams.failed')));}} />
      <Text style={{color:c.text}}>{t('teams.response')}</Text><TextInput accessibilityLabel={t('teams.response')} secureTextEntry autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} editable={!busy&&!!key} maxLength={300000} style={{color:c.text,borderColor:c.border,borderWidth:1,padding:12,borderRadius:12}} />
      <Action label={t('teams.connect')} disabled={busy||!code||!key} onPress={()=>{void connect();}} />
    </>}
    {connected&&<><Text style={{color:c.dimmed}}>{t('teams.connected')}</Text>
      {!room?<>{rooms.map(r=><Pressable key={r.id} accessibilityRole="button" disabled={busy||r.kind==='unsupported'} onPress={()=>{void loadRoom(r);}} style={{paddingVertical:10}}><Text style={{color:r.kind==='unsupported'?c.dimmed:c.text}}>{r.name}</Text>{r.kind==='unsupported'&&<Text style={{color:c.dimmed}}>{t('teams.unsupported')}</Text>}</Pressable>)}<Action label={t('slack.refresh')} disabled={busy} onPress={()=>{void loadRooms();}} /></>:<>
        <Action label={t('slack.back')} disabled={busy} onPress={()=>{setRoom(null);setMessages([]);setCursor(null);seen.current.clear();}}/><Text style={{color:c.text,fontWeight:'700'}}>{room.name}</Text>
        {messages.map(m=><View key={m.key} style={{paddingVertical:10,gap:4,borderBottomWidth:1,borderColor:c.border}}><Text style={{color:c.dimmed,fontSize:12}}>{m.author+' · '+new Date(m.arrivedAt).toLocaleString()}</Text><Text selectable style={{color:c.text}}>{m.format==='unsupported'?t('teams.unsupported'):messageText(m)||t('slack.unsupportedContent')}</Text></View>)}
        <Action label={t('slack.refresh')} disabled={busy} onPress={()=>{void loadRoom(room);}}/>{cursor&&<Action label={t('slack.more')} disabled={busy} onPress={()=>{void loadRoom(room,true);}} />}
      </>}
      {(room?messages:rooms).length===0&&<Text style={{color:c.dimmed}}>{t('slack.empty')}</Text>}
    </>}
    {busy&&<Text accessibilityLiveRegion="polite" style={{color:c.dimmed}}>{t('slack.loading')}</Text>}{status&&<Text accessibilityLiveRegion="polite" style={{color:c.text}}>{status}</Text>}
    <Action label={t('slack.disconnect')} onPress={reset}/><Action label={t('slack.hide')} onPress={()=>{reset();onHide();}}/>
  </View>;
}
function Action({label,onPress,disabled=false}:{label:string;onPress:()=>void;disabled?:boolean}){const c=useColors();return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{paddingVertical:12,opacity:disabled?0.5:1}}><Text style={{color:c.accent,fontWeight:'700'}}>{label}</Text></Pressable>;}
