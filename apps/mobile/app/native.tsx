/** Experimental native messaging flow. Every displayed message comes from SQLite. */
import * as Crypto from 'expo-crypto';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ouvrirBase } from '../db/client.ts';
import { migrerBase } from '../db/migrer.ts';
import type { Session } from '../lib/auth.ts';
import { idDepuisOctets } from '../lib/envoi.ts';
import { NativeChat, type NativeStatus } from '../fournisseurs/rocketvibe/chat.ts';
import { NativeStore, type NativeRoomRow, type NativeMessageRow } from '../fournisseurs/rocketvibe/store.ts';
import { NativeError } from '../fournisseurs/rocketvibe/transport.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { useT } from '../ui/i18n.ts';
import { Marque } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { POLICES, useCouleurs } from '../ui/theme.ts';
import type { ClientRest } from '../lib/rest.ts';
import type { CleTraduction } from '../ui/messages.ts';
import { useRetourMateriel } from '../ui/retourMateriel.ts';

export default function NativeScreen() {
  const {etat} = useSession();
  if (etat.phase !== 'connecte') return <Redirect href="/connexion" />;
  if (etat.session.genre !== 'rocketvibe') return <Redirect href="/" />;
  return <NativeConversations key={`${etat.session.baseUrl}:${etat.session.userId}:${etat.session.nativeInstanceId}:${etat.session.nativeDataEpoch}`} session={etat.session} client={etat.client} />;
}

function NativeConversations({session,client}: {session:Session;client:ClientRest}) {
  const t = useT(); const c = useCouleurs(); const router = useRouter(); const insets = useSafeAreaInsets();
  const {deconnecter} = useSession();
  const [chat,setChat] = useState<NativeChat | null>(null);
  const [rooms,setRooms] = useState<NativeRoomRow[]>([]);
  const [messages,setMessages] = useState<NativeMessageRow[]>([]);
  const [status,setStatus] = useState<NativeStatus>({online:false,error:null});
  const [selected,setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const messageLimit = useRef(100);
  useEffect(() => {selectedRef.current = selected;},[selected]);
  const [draft,setDraft] = useState(''); const [roomName,setRoomName] = useState('');
  const [username,setUsername] = useState(''); const [privateRoom,setPrivateRoom] = useState(true);
  const [busy,setBusy] = useState(false); const inFlight = useRef(false);
  const [error,setError] = useState<CleTraduction | null>(null); const [older,setOlder] = useState(true);
  const active = rooms.find(room => room.rid === selected);
  const choose = useCallback((rid:string | null) => {
    selectedRef.current = rid; messageLimit.current = 100; setSelected(rid); setMessages([]); setOlder(true); setDraft(''); setUsername('');
  },[]);
  useRetourMateriel(selected !== null, useCallback(() => choose(null),[choose]));

  useEffect(() => {
    let alive = true; let runner:NativeChat | null = null; let unlisten:(() => void) | undefined;
    const subscription = AppState.addEventListener('change',state => {
      if (state === 'active') runner?.resume(); else runner?.suspend();
    });
    void (async () => {
      const connection = ouvrirBase(session.baseUrl,session.userId);
      await migrerBase(session.baseUrl,session.userId);
      if (!alive) return;
      const store = new NativeStore(connection.brute,connection.fileEcritures,session);
      runner = new NativeChat(session,store,() => idDepuisOctets(Crypto.getRandomBytes(12)),{revoke:token => client.surJetonRefuse?.(token)});
      const current = runner;
      const reload = async () => {
        const rid = selectedRef.current;
        const nextRooms = await store.rooms();
        const nextMessages = rid === null ? [] : await store.messages(rid,messageLimit.current);
        if (!alive) return;
        setRooms(nextRooms); setStatus({...current.status});
        if (selectedRef.current === rid) setMessages(nextMessages);
      };
      unlisten = current.subscribe(() => { void reload().catch(() => { if (alive) setError('native.error'); }); });
      setChat(current); await reload();
      if (alive) { if (AppState.currentState === 'active') current.start(); else current.suspend(); }
    })().catch(() => { if (alive) setError('native.error'); });
    return () => { alive = false; subscription.remove(); unlisten?.(); runner?.stop(); };
  },[session,client]);

  useEffect(() => {
    if (!chat || !selected) return;
    let alive = true;
    void chat.store.messages(selected,messageLimit.current).then(rows => { if (alive) setMessages(rows); });
    if (status.online) void chat.history(selected).then(more => { if (alive) setOlder(more); }).catch(() => {});
    return () => { alive = false; };
  },[chat,selected,status.online]);

  const act = useCallback(async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await fn(); }
    catch (problem) { setError(problem instanceof NativeError && problem.code === 'server_identity_changed' ? 'native.identityChanged' : problem instanceof NativeError && problem.code === 'permission_denied' ? 'native.ownerOnly' : 'native.error'); }
    finally { inFlight.current = false; setBusy(false); }
  },[]);
  const loadOlder = async (rid:string) => {
    if (!chat) return;
    const limit = messageLimit.current + 50;
    let rows = await chat.store.messages(rid,limit + 1);
    let more = true;
    if (rows.length <= messageLimit.current) {
      more = await chat.history(rid,true);
      rows = await chat.store.messages(rid,limit + 1);
    }
    if (selectedRef.current !== rid) return;
    messageLimit.current = limit;
    setMessages(rows.slice(0,limit)); setOlder(more || rows.length > limit);
  };
  const fieldStyle = [styles.field,{color:c.texte,backgroundColor:c.carte,borderColor:c.bordure}];
  const fatal = status.error === 'server_identity_changed';

  return <VueEvitantLeClavier>
    <Stack.Screen options={{headerShown:false}} />
    <View style={[styles.header,{paddingTop:insets.top + 12,borderColor:c.bordureDouce}]}>
      {active ? <NativeButton label={t('salon.retour')} onPress={() => choose(null)} /> : <Marque c={c} taille={24} />}
      <View style={styles.title}>
        <Text numberOfLines={1} style={{color:c.texte,fontFamily:POLICES.titre,fontSize:19}}>{active?.nom ?? t('native.title')}</Text>
        <Text numberOfLines={1} style={{color:c.texteSecondaire,fontSize:12}}>{status.online ? t('native.online') : t('native.offline')}</Text>
      </View>
      <NativeButton label={t('commun.reessayer')} onPress={() => chat?.refresh()} disabled={fatal || busy} />
    </View>
    {(error || fatal) && <Text accessibilityRole="alert" style={[styles.notice,{color:c.texteErreur}]}>{t(fatal ? 'native.identityChanged' : error ?? 'native.error')}</Text>}
    {!chat && !error && <ActivityIndicator accessibilityLabel={t('native.loading')} color={c.accent} style={styles.notice} />}
    {active ? <>
      <FlatList data={messages} inverted keyExtractor={message => message.id} contentContainerStyle={styles.list} renderItem={({item}) => <View style={[styles.message,{backgroundColor:item.auteur_id === session.userId ? c.surfaceActive : c.carte}]}>
        <Text style={{color:c.texteSecondaire,fontFamily:POLICES.corpsGras}}>{item.auteur_nom}</Text>
        <Text selectable style={{color:c.texteMessage,fontFamily:POLICES.corps,fontSize:16}}>{item.texte}</Text>
        {item.statut && <Text style={{color:c.texteSecondaire}}>{t(item.statut === 'echec' ? 'native.failed' : 'native.pending')}</Text>}
        {item.statut === 'echec' && <View style={styles.row}>
          <NativeButton label={t('commun.reessayer')} onPress={() => {void act(async () => {await chat?.retry(item.id);});}} disabled={busy} />
          <NativeButton label={t('commun.supprimer')} onPress={() => {void act(async () => {await chat?.abandon(item.id);});}} disabled={busy} />
        </View>}
      </View>} ListFooterComponent={older ? <NativeButton label={t('native.older')} onPress={() => {void act(() => loadOlder(active.rid));}} disabled={!status.online || busy} /> : null} />
      {active.type !== 'd' && <View style={styles.row}>
        <TextInput accessibilityLabel={t('native.username')} placeholder={t('native.username')} placeholderTextColor={c.texteTertiaire} value={username} onChangeText={setUsername} autoCapitalize="none" style={[fieldStyle,styles.grow]} />
        <NativeButton label={t('native.invite')} onPress={() => {void act(async () => {await chat?.invite(active.rid,username);setUsername('');});}} disabled={!status.online || !username.trim() || busy} />
      </View>}
      <View style={styles.row}>
        <TextInput accessibilityLabel={t('commun.envoyer')} multiline placeholder={t('native.message')} placeholderTextColor={c.texteTertiaire} value={draft} onChangeText={setDraft} style={[fieldStyle,styles.composer]} />
        <NativeButton label={t('commun.envoyer')} onPress={() => {const sent = draft; void act(async () => {await chat?.send(active.rid,sent);setDraft(current => current === sent ? '' : current);});}} disabled={!draft.trim() || fatal || busy} />
      </View>
    </> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {rooms.length === 0 && chat && <Text style={{color:c.texteSecondaire}}>{t('native.empty')}</Text>}
      {rooms.map(room => <Pressable key={room.rid} accessibilityRole="button" accessibilityLabel={room.nom} onPress={() => choose(room.rid)} style={[styles.room,{borderColor:c.bordureDouce}]}>
        <Text numberOfLines={1} style={{color:c.texte,fontFamily:POLICES.corpsGras,fontSize:17}}>{room.type === 'p' ? '🔒 ' : ''}{room.nom}</Text>
        <Text numberOfLines={1} style={{color:c.texteSecondaire}}>{room.dernier_message}</Text>
      </Pressable>)}
      <TextInput accessibilityLabel={t('native.roomName')} placeholder={t('native.roomName')} placeholderTextColor={c.texteTertiaire} value={roomName} onChangeText={setRoomName} style={fieldStyle} />
      <View style={styles.row}><Text style={{color:c.texte}}>{t('native.private')}</Text><Switch accessibilityLabel={t('native.private')} value={privateRoom} onValueChange={setPrivateRoom} /></View>
      <NativeButton label={t('native.create')} onPress={() => {void act(async () => {if (chat) {choose(await chat.createRoom(roomName,privateRoom));setRoomName('');}});}} disabled={!status.online || !roomName.trim() || busy} />
      <TextInput accessibilityLabel={t('native.username')} placeholder={t('native.username')} placeholderTextColor={c.texteTertiaire} value={username} onChangeText={setUsername} autoCapitalize="none" style={fieldStyle} />
      <NativeButton label={t('native.direct')} onPress={() => {void act(async () => {if (chat) choose(await chat.direct(username));});}} disabled={!status.online || !username.trim() || busy} />
      <NativeButton label={t('native.changeServer')} onPress={() => router.push({pathname:'/connexion',params:{changer:'1'}})} disabled={busy} />
      <NativeButton label={t('parametres.seDeconnecter')} onPress={() => {void deconnecter();}} disabled={busy} />
    </ScrollView>}
  </VueEvitantLeClavier>;
}

function NativeButton({label,onPress,disabled=false}: {label:string;onPress:() => void;disabled?:boolean}) {
  const c = useCouleurs();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} style={[styles.button,{borderColor:c.bordure,opacity:disabled ? 0.5 : 1}]}>
    <Text style={{color:c.violet,fontFamily:POLICES.corpsGras}}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  header:{flexDirection:'row',alignItems:'center',gap:8,padding:12,borderBottomWidth:1},title:{flex:1,minWidth:0},
  list:{padding:16,gap:12},room:{paddingVertical:14,borderBottomWidth:1},row:{flexDirection:'row',alignItems:'center',gap:8,padding:8},
  field:{borderWidth:1,borderRadius:14,padding:12,fontFamily:POLICES.corps,fontSize:16},grow:{flex:1,minWidth:0},
  composer:{flex:1,minWidth:0,maxHeight:140},button:{padding:10,borderWidth:1,borderRadius:12,alignSelf:'flex-start'},
  message:{padding:14,borderRadius:16,gap:6,marginVertical:5},notice:{padding:14},
});
