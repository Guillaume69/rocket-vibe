import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CryptoNative } from '../modules/crypto-native/index.ts';
import type { CryptoConversationAccess } from '../providers/rocketvibe/cryptoConversations.ts';
import { privateRow } from '../providers/rocketvibe/cryptoProjection.ts';
import type { Provider } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { MessageRow, type MessageRowData } from '../ui/messageRow.tsx';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import {useSync} from '../ui/sync.tsx';
import { useColors, type Colors, FONTS } from '../ui/theme.ts';

/**
 * Message search within one room, through its provider. Results are
 * temporary: rendered straight from the response (normalised by `toMessage`,
 * like any server document), never written to the database; isolated
 * messages outside the window have no business there. No jump to the message
 * in history: noted, will come with a real targeted backward pagination.
 * An encrypted RocketVibe room is searched on the device only, through its
 * private journal (`CryptoConversationAccess.search`); the server sees nothing.
 */

/** Stable (module-level): a value recreated on every render would rerun the effect. */
const NO_MESSAGE: MessageRowData[] = [];
const NO_RESULT:{version:string|null;revision:number;messages:MessageRowData[]}={version:null,revision:-1,messages:NO_MESSAGE};
function versionOf(f:Provider):string {return JSON.stringify([f.identity,f.native?.chat.searchVersion??null]);}

export default function MessageSearchScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync=useSync();
  const c = useColors();
  const t = useT();

  // Same gatekeeper as the room: a deep link can land here without a session.
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if(sync.phase==='error')return <View style={[styles.center,{backgroundColor:c.background}]}><Text style={[styles.errorMessage,{color:c.errorText}]}>{sync.message}</Text></View>;

  if (state.phase !== 'connected' || sync.phase!=='ready' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('common.search') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <MessageSearch c={c} client={state.client} rid={rid} provider={sync.provider} username={state.session.username} />;
}

function MessageSearch({
  c,
  client,
  rid,
  provider,
  username,
}: {
  c: Colors;
  client: RestClient;
  rid: string;
  provider:Provider;
  username:string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [requestRevision,setRequestRevision]=useState(0);
  const version=useSyncExternalStore(
    useCallback(listen=>provider.native?.chat.subscribe(listen)??(()=>{}),[provider]),
    ()=>versionOf(provider),
  );

  // Results are normalised on arrival (`toMessage`, like any server
  // document), never written to the database; see the file header.
  // An encrypted room's own actor, closed with the screen or in background.
  const privateAccess=useRef<CryptoConversationAccess|null>(null),token=useRef(Math.floor(Math.random()*2**52));
  useEffect(()=>{
    const close=()=>{void privateAccess.current?.close();privateAccess.current=null;provider.native?.chat.forgetPrivateFiles(token.current);};
    const sub=AppState.addEventListener('change',state=>{if(state!=='active')close();});
    return()=>{sub.remove();close();};
  },[provider]);
  const searchPrivately=useCallback(async(clean:string):Promise<MessageRowData[]|null>=>{
    const native=provider.native;
    const scope=native?await native.store.cryptoRoomAccess(rid):null;
    if(!native || !scope?.encrypted)return null;
    if(scope.membership===null || !CryptoNative)throw new Error('unsupported_feature');
    if(!privateAccess.current || privateAccess.current.isClosed)
      privateAccess.current=await native.chat.cryptoConversation(CryptoNative,rid,scope.membership,()=>AppState.currentState==='active',null);
    const found=await privateAccess.current.search(clean);
    // Their encrypted files open while the results are shown (E2EE_FILES.md).
    native.chat.forgetPrivateFiles(token.current);
    native.chat.registerPrivateFiles(token.current,rid,found.messages.flatMap(m=>m.document.files??[]));
    const self=client.auth?.userId?{id:client.auth.userId,username}:undefined;
    return found.messages.map(m=>privateRow(m,rid,0,null,self));
  },[provider,rid,client,username]);
  const searchMessages = useCallback(
    async(clean: string) => {
      const version=versionOf(provider);
      const found=await searchPrivately(clean);
      if(found)return {version,revision:requestRevision,messages:found};
      if(!provider.capabilities.search || !provider.searchMessages)throw new Error('unsupported_feature');
      return {version,revision:requestRevision,messages:await provider.searchMessages(rid,clean) as MessageRowData[]};
    },
    [provider, rid,requestRevision,searchPrivately],
  );
  const { results, message, answered } = useDebouncedSearch(
    query,
    NO_RESULT,
    searchMessages,
    t('messageSearch.searchFailed'),
  );
  const clean = query.trim();
  const searching = clean !== '' && message===null && (answered !== clean || results.revision!==requestRevision);
  const expired=results.version!==null && results.version!==version && answered===clean;

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('messageSearch.title') }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={()=>setRequestRevision(v=>v+1)}
          returnKeyType="search"
          placeholder={t('messageSearch.placeholder')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
      </View>
      {message !== null && (
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
      )}
      <FlatList
        data={results.version===version && results.revision===requestRevision && answered===clean?results.messages:NO_MESSAGE}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={styles.result}>
            <MessageRow
              c={c}
              // LocalMessage and the SQLite row share exactly these
              // fields: it is the same normalised server document.
              message={item}
              client={client}
              sendStatus={null}
              onRetry={null}
              onDiscard={null}
              // No actions here: the sheet reads the database by id, and an
              // old result is not necessarily there; a false promise.
              onLongPress={null}
              onOpenThread={null}
              // Same reason for reactions: read only, nothing marked.
              me={null}
              onReact={null}
              // Scattered results, not a stream: each keeps its header.
              continuation={false}
              repeatedTime={false}
            />
          </View>
        )}
        ListEmptyComponent={
          query.trim() === '' ? null : searching ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : expired ? (
            <Text style={[styles.empty,{color:c.dimmed}]}>{t('messageSearch.edited')}</Text>
          ) : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('messageSearch.noMessages')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  content: { paddingHorizontal: 16 },
  result: { paddingVertical: 2 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});
