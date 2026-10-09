import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SlackError, SlackReader, type SlackIdentity, type SlackConversation, type SlackMessage } from '../providers/slack/client.ts';
import { useT } from './i18n.ts';
import { useColors } from './theme.ts';
export function SlackPreview({ onHide }: { onHide: () => void }) {
  const t = useT(), c = useColors();
  const [token,setToken] = useState(''), [cookie,setCookie] = useState('');
  const [identity,setIdentity] = useState<SlackIdentity|null>(null);
  const [rooms,setRooms] = useState<SlackConversation[]>([]), [messages,setMessages] = useState<SlackMessage[]>([]);
  const [room,setRoom] = useState<SlackConversation|null>(null);
  const [roomCursor,setRoomCursor] = useState<string|null>(null), [messageCursor,setMessageCursor] = useState<string|null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null);
  const reader = useRef<SlackReader|null>(null), generation = useRef(0), inFlight = useRef(false);
  const roomCursors = useRef(new Set<string>()), messageCursors = useRef(new Set<string>());
  useEffect(() => () => { generation.current++; reader.current?.close(); reader.current = null; },[]);
  const reset = () => {
    generation.current++; reader.current?.close(); reader.current = null;
    setToken(''); setCookie(''); setIdentity(null); setRooms([]); setMessages([]); setRoom(null);
    setRoomCursor(null); setMessageCursor(null); inFlight.current = false; setBusy(false); setError(null);
    roomCursors.current.clear(); messageCursors.current.clear();
  };
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = generation.current; setBusy(true); setError(null);
    try { await work(); } catch(e) {
      if (version === generation.current) setError(t('slack.failed') + ' (' + (e instanceof SlackError ? e.code : 'connection_failed') + (e instanceof SlackError && e.retryAfter !== null ? ', ' + e.retryAfter + 's' : '') + ')');
    } finally { if (version === generation.current) { inFlight.current = false; setBusy(false); } }
  };
  const connect = () => run(async () => {
    const client = new SlackReader(token,cookie); reader.current?.close(); reader.current = client;
    const version = generation.current;
    const who = await client.authenticate();
    if (version !== generation.current) return;
    setIdentity(who); setToken(''); setCookie('');
    const page = await client.conversations();
    if (version !== generation.current) return;
    setRooms(page.items); setRoomCursor(page.nextCursor);
  });
  const loadRooms = () => run(async () => {
    if (!reader.current) return;
    if (roomCursor && roomCursors.current.has(roomCursor)) throw new SlackError('pagination_loop');
    const version = generation.current, requested = roomCursor;
    const page = await reader.current.conversations(requested ?? undefined);
    if (version !== generation.current) return;
    if (requested) roomCursors.current.add(requested);
    setRooms(old => [...new Map([...old,...page.items].map(r => [r.id,r])).values()]); setRoomCursor(page.nextCursor);
  });
  const loadRoom = (target: SlackConversation, more = false) => run(async () => {
    if (!reader.current) return;
    if (!more) { setRoom(target); setMessages([]); setMessageCursor(null); messageCursors.current.clear(); }
    const version = generation.current, requested = more ? messageCursor : null;
    if (requested && messageCursors.current.has(requested)) throw new SlackError('pagination_loop');
    const page = await reader.current.history(target.id,requested ?? undefined);
    if (version !== generation.current) return;
    if (requested) messageCursors.current.add(requested);
    setMessages(old => [...new Map([...(more ? old : []),...page.items].map(m => [m.ts,m])).values()]); setMessageCursor(page.nextCursor);
  });
  return <View style={{backgroundColor:c.card,borderRadius:20,padding:18,gap:10,alignSelf:'stretch'}}>
    <Text style={{color:c.text,fontSize:20,fontWeight:'700'}}>{t('slack.title')}</Text>
    <Text style={{color:c.dimmed}}>{t('slack.previewHelp')}</Text>
    {!identity && <>
      <Text style={{color:c.text}}>{t('slack.token')}</Text>
      <TextInput accessibilityLabel={t('slack.token')} secureTextEntry autoCapitalize="none" autoCorrect={false} value={token} onChangeText={setToken} editable={!busy} style={{color:c.text,borderColor:c.border,borderWidth:1,padding:12,borderRadius:12}} />
      <Text style={{color:c.text}}>{t('slack.cookie')}</Text>
      <TextInput accessibilityLabel={t('slack.cookie')} secureTextEntry autoCapitalize="none" autoCorrect={false} value={cookie} onChangeText={setCookie} editable={!busy} style={{color:c.text,borderColor:c.border,borderWidth:1,padding:12,borderRadius:12}} />
      <PreviewButton label={t('slack.connect')} onPress={() => { void connect(); }} disabled={busy || !token || !cookie} />
    </>}
    {identity && <>
      <Text style={{color:c.text}}>{identity.team + ' · @' + identity.user}</Text>
      {!room ? <>
        {rooms.map(r => <Pressable key={r.id} accessibilityRole="button" disabled={busy} onPress={() => { void loadRoom(r); }} style={{paddingVertical:10}}><Text style={{color:c.text}}>{(r.kind==='channel'?'# ':r.kind==='private'?'🔒 ':'') + r.name}</Text></Pressable>)}
        {rooms.length===0 && <Text style={{color:c.dimmed}}>{t('slack.empty')}</Text>}
        {(roomCursor || rooms.length===0) && <PreviewButton label={t(roomCursor ? 'slack.more' : 'slack.refresh')} onPress={() => { void loadRooms(); }} disabled={busy} />}
      </> : <>
        <PreviewButton label={t('slack.back')} onPress={() => { setRoom(null); setMessages([]); setMessageCursor(null); }} disabled={busy} />
        <Text style={{color:c.text,fontWeight:'700'}}>{room.name}</Text>
        {messages.map(m => <View key={m.ts} style={{borderBottomWidth:1,borderColor:c.border,paddingVertical:10,gap:4}}><Text style={{color:c.dimmed,fontSize:12}}>{m.user + ' · ' + new Date(Number(m.ts.split('.')[0])*1000).toLocaleString()}</Text><Text selectable style={{color:c.text}}>{m.text || t('slack.unsupportedContent')}</Text></View>)}
        {messages.length===0 && <Text style={{color:c.dimmed}}>{t('slack.empty')}</Text>}
        <PreviewButton label={t('slack.refresh')} onPress={() => { void loadRoom(room); }} disabled={busy} />
        {messageCursor && <PreviewButton label={t('slack.more')} onPress={() => { void loadRoom(room,true); }} disabled={busy} />}
      </>}
    </>}
    {busy && <Text accessibilityLiveRegion="polite" style={{color:c.dimmed}}>{t('slack.loading')}</Text>}
    {error && <Text accessibilityRole="alert" style={{color:c.text}}>{error}</Text>}
    <PreviewButton label={t(identity || busy ? 'slack.disconnect' : 'common.cancel')} onPress={reset} />
    <PreviewButton label={t('slack.hide')} onPress={() => { reset(); onHide(); }} />
  </View>;
}

function PreviewButton({label,onPress,disabled=false}:{label:string;onPress:()=>void;disabled?:boolean}) {
  const c=useColors();
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{paddingVertical:12,opacity:disabled?0.5:1}}><Text style={{color:c.accent,fontWeight:'700'}}>{label}</Text></Pressable>;
}
