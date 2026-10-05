import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../../ui/liveQuery.ts';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../../db/client.ts';
import type { DraftStore } from '../../db/store.ts';
import { messages, rooms, outbox, nativeRoomAccess } from '../../db/schema.ts';
import {CryptoNative} from '../../modules/crypto-native/index.ts';
import {privateRows} from '../../providers/rocketvibe/cryptoProjection.ts';
import {usePrivateQuotes} from '../../ui/privateQuotes.ts';
import {useEncryptedConversation,privateRow,privateInterrupted} from '../../ui/encryptedConversation.ts';
import {Tappable} from '../../ui/tappable.tsx';
import type { ActivityEngine } from '../../lib/activity.ts';
import type { ProviderActions, Provider, Listener, Outbox } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { SyncEngine } from '../../lib/sync.ts';
import { useActivity } from '../../ui/activity.ts';
import { useDraft } from '../../ui/drafts.ts';
import {RoomMembershipBound} from '../../ui/roomMembership.tsx';
import {ObservedRead} from '../../ui/observedRead.ts';
import { threadLoadedUnder, markThreadLoaded } from '../../ui/loadedThreads.ts';
import { repeatedTimeIds, continuationIds } from '../../ui/messageGrouping.ts';
import { insertDaySeparators, type DayRow } from '../../ui/daySeparator.ts';
import { sessionToken } from '../../ui/sessionToken.ts';
import { SyncBar, DaySeparator } from '../../ui/kit.tsx';
import { KeyboardAvoidingContainer } from '../../ui/keyboard.tsx';
import { useMentionCandidates } from '../../ui/mentionCompletion.tsx';
import { Composer } from '../../ui/composer.tsx';
import { useT } from '../../ui/i18n.ts';
import { MessageRow, type MessageRowData } from '../../ui/messageRow.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { useColors, type Colors, FONTS } from '../../ui/theme.ts';

/**
 * Thread screen (8.3). `id` = `_id` of the root message (`tmid` of its
 * replies). Same architecture as the room: SQLite projected by live queries,
 * the network (REST `chat.getThreadMessages` + stream) writes to SQLite.
 *
 * A thread is short and finite: the provider loads it whole on opening
 * (`chat.getThreadMessages` in pages of 100, 20 pages at most), with no
 * on-screen pagination.
 */

export default function ThreadScreen() {
  const { id, message, rid } = useLocalSearchParams<{ id: string;message?:string;rid?:string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  if (sync.phase === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.error, { color: c.errorText }]}>{sync.message}</Text>
      </View>
    );
  }
  if (typeof id !== 'string' || sync.phase !== 'ready' || state.phase !== 'connected') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ThreadFrame
      c={c}
      threadId={id}
      roomId={typeof rid==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(rid)?rid:null}
      messageTarget={typeof message==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(message)?message:null}
      base={sync.base}
      drafts={sync.drafts}
      engine={sync.engine}
      outbox={sync.outbox}
      ddp={sync.ddp}
      provider={sync.provider}
      actions={sync.actions}
      client={state.client}
      me={state.session.username}
      activity={sync.activity}
      generation={sync.generation}
    />
  );
}

function ThreadFrame(props:Omit<Parameters<typeof Thread>[0],'membership'>){
  const {data}=useCoalescedLiveQuery(props.base.select({rid:messages.rid}).from(messages).where(or(eq(messages.id,props.threadId),eq(messages.threadId,props.threadId))).limit(1),[props.threadId]);
  const rid=props.roomId??data?.[0]?.rid;
  if(!props.provider.native)return <Thread {...props}/>;
  return rid?<RoomMembershipBound base={props.base} rid={rid}>{membership=><Thread {...props} membership={membership}/>}</RoomMembershipBound>:<Thread {...props} membership={null}/>;
}

function Thread({
  c,
  threadId,
  base,
  drafts,
  engine,
  outbox: outboxQueue,
  ddp,
  provider,
  actions,
  client,
  me,
  activity,
  generation,
  membership,
  messageTarget,
  roomId,
}: {
  c: Colors;
  threadId: string;
  messageTarget:string|null;
  roomId:string|null;
  base: LocalDatabase;
  drafts: DraftStore;
  engine: SyncEngine;
  outbox: Outbox;
  ddp: Listener;
  provider: Provider;
  actions: ProviderActions;
  client: RestClient;
  /** My username: marks my reactions in the rows. */
  me: string;
  activity: ActivityEngine;
  generation: number;
  membership?:string|null;
}) {
  const t = useT();
  const syncing = useActivity(threadId);
  // The thread root: it carries the title and the `rid`.
  const { data: rootRows } = useCoalescedLiveQuery(
    base.select().from(messages).where(and(eq(messages.id, threadId),provider.native && roomId?eq(messages.rid,roomId):undefined)).limit(1),
    [threadId,roomId],
  );
  const root = rootRows?.[0];

  const { data: replyRows } = useCoalescedLiveQuery(
    base
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId),provider.native && roomId?eq(messages.rid,roomId):undefined))
      // Secondary key `id` (same reason as the room screen): a tie to the
      // millisecond is broken deterministically, not by insertion order. ASC
      // order here to stay consistent with the room's DESC sort: two linked
      // messages keep the same relation in both views.
      .orderBy(...(provider.messageOrder==='sequence'?[
        asc(sql`(SELECT position FROM native_positions WHERE id=${messages.id}) IS NULL`),
        asc(sql`length((SELECT position FROM native_positions WHERE id=${messages.id}))`),
        asc(sql`(SELECT position FROM native_positions WHERE id=${messages.id})`),
      ]:[]),asc(messages.ts), asc(messages.id)),
    [threadId,roomId],
  );

  // `rid`: from the root, or FAILING THAT from a reply (cold direct link;
  // `chat.getThreadMessages` never returns the root, but every reply carries
  // the rid). Without this fallback, the screen could neither subscribe to the
  // stream nor reply until the root has arrived.
  const rid = provider.native && roomId ? roomId : root?.rid ?? (replyRows ?? [])[0]?.rid;

  // The room's flags: same prohibitions as the room composer; promising a
  // reply in an encrypted or read-only room means promising an
  // `error-not-allowed`.
  const { data: roomRows } = useCoalescedLiveQuery(
    base
      .select()
      .from(rooms)
      .where(eq(rooms.rid, rid ?? ''))
      .limit(1),
    [rid],
  );
  const room = roomRows?.[0];
  const native=provider.native;
  const protectedRoom=!!native && room?.encrypted===true;
  const cryptoAvailable=!!CryptoNative && native?.chat.capabilities?.e2ee===true && native.chat.capabilities.device_sessions===true;
  const conversation=useEncryptedConversation(native?.chat,rid??'',membership,protectedRoom && cryptoAvailable,threadId);
  const {data:nativePermissions}=useCoalescedLiveQuery(base.select().from(nativeRoomAccess).where(eq(nativeRoomAccess.rid,rid??'')).limit(1),[rid]);
  const { data: outboxRows } = useCoalescedLiveQuery(
    base.select().from(outbox).where(eq(outbox.threadId, threadId)),
    [threadId],
  );
  const outboxById = useMemo(
    () => new Map((outboxRows ?? []).map((s) => [s.id, s])),
    [outboxRows],
  );

  // Root first, replies in chronological order: a thread reads from the top.
  const sourceData = useMemo<MessageRowData[]>(() => {
    if(protectedRoom)return privateRows(conversation.view,rid??'',true);
    if(native && room===undefined)return [];
    const responses = replyRows ?? [];
    return root === undefined ? responses : [root, ...responses];
  }, [root,replyRows,protectedRoom,conversation.view,rid,native,room]);
  const quotes=usePrivateQuotes(native?.chat,rid??'',membership,!protectedRoom && cryptoAvailable,sourceData,threadId);
  const quotesToSend=quotes.send;
  const data=quotes.rows;

  // Day separators then grouping of bursts by the same author
  // (`ui/daySeparator`, `ui/messageGrouping`): ASC data here, the reverse of
  // the room screen.
  const listData = useMemo<(MessageRowData | DayRow)[]>(
    () => insertDaySeparators(data, 'oldest-first'),
    [data],
  );
  const continuations = useMemo(() => continuationIds(listData, 'oldest-first'), [listData]);
  const repeatedTimes = useMemo(
    () => repeatedTimeIds(listData, 'oldest-first', continuations),
    [listData, continuations],
  );

  // The full thread, from the server: replayable, same idempotent upserts.
  // `generation`: a thread opened offline fills in at connection setup.
  // A thread already loaded under this generation has no first pass to wait
  // for: without this initial state, skipping the fetch would leave "loading"
  // shown for life (same trap as the room screen).
  const [firstPassDone, setFirstPassDone] = useState(() =>
    threadLoadedUnder(threadId, generation),
  );
  useEffect(() => {
    if(protectedRoom || native && roomId && !room)return;
    // This loading is only replayed IF this thread has not already been loaded
    // under this connection generation. With `generation` in the deps, each
    // connection setup (so each return to the foreground, each network flap)
    // restarted `chat.getMessage` THEN the whole thread pagination, to
    // re-ingest the same documents. See `ui/loadedThreads.ts`.
    if (threadLoadedUnder(threadId, generation)) return;
    let canceled = false;
    const token = sessionToken();
    // Activity scope = the thread itself, not its room: `rid` is not yet known
    // when this loading starts (thread opened by direct link, the root is not in
    // the database) and it would appear DURING the fetch; the bar would then
    // listen to a scope nobody fed.
    // The loading (root then defensive pagination of replies) lives in the
    // provider; see `loadThread` on the Rocket.Chat side for its quirks.
    void activity
      .track(threadId, provider.loadThread(engine, threadId, () => canceled))
      .then(() => {
        // Marked on SUCCESS only: a thread opened offline must start again at the
        // next connection setup, not stay empty.
        if (!canceled) markThreadLoaded(threadId, generation, token);
      })
      .catch(() => {
        // Offline: the local cache is enough.
      })
      .finally(() => {
        if (!canceled) setFirstPassDone(true);
      });
    return () => {
      canceled = true;
    };
  }, [provider,engine,threadId,generation,activity,protectedRoom,native,roomId,room]);

  // Replies arrive through the ROOM's stream: we subscribe to it from here as
  // well, so the thread lives even when opened by a direct link (refcounted
  // subscription; see ddp.subscribe). We arm EVERYTHING the provider declares
  // for a room, including the typing activity this screen does not show: in
  // the common case (thread stacked on its room), the refcount means no extra
  // `sub` goes out; by cold direct link, these beats are classified "silence"
  // by the translator, the price of a facade that does not detail its keys.
  useEffect(() => {
    if (rid === undefined) return;
    const releases = provider
      .roomSubscriptions(rid)
      .map(([name, key]) => ddp.subscribe(name, key));
    return () => {
      for (const release of releases) release();
    };
  }, [ddp, provider, rid]);

  const router = useRouter();
  const openActions = useCallback(
    (idMessage: string) => {
      // "Pop" when the sheet opens: confirms the long press registered.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // `thread`: a possible reply target goes back to THIS thread's composer,
      // not to that of the room stacked below.
      router.push({ pathname: '/message-actions', params: { id: idMessage, thread: threadId, ...(protectedRoom?{isPrivate:'1',rid}:{}) } });
    },
    [router, threadId,protectedRoom,rid],
  );
  const retry = useCallback((idMessage:string) => {
    (protectedRoom?conversation.outbox.retry!(idMessage):outboxQueue.process()).catch(() => {});
  }, [outboxQueue,protectedRoom,conversation.outbox]);
  const discard = useCallback(
    (idMessage: string) => {
      (protectedRoom?conversation.outbox:outboxQueue).discard(idMessage).catch(() => {});
    },
    [outboxQueue,protectedRoom,conversation.outbox],
  );
  // Fire-and-forget, like the room screen: the stream's echo rewrites
  // `messages.reactions`, the live query re-renders the chip.
  const react = useCallback(
    (ridMessage: string, idMessage: string, code: string, put: boolean) => {
      actions.react(ridMessage, idMessage, code, put).catch(() => {});
    },
    [actions],
  );

  const renderRow = useCallback(
    ({ item }: { item: MessageRowData | DayRow }) => {
      if ('day' in item) {
        return <DaySeparator c={c} ts={item.ts} />;
      }
      const sendState = outboxById.get(item.id);
      const isPrivate=protectedRoom?privateRow(conversation.view,item.id):undefined;
      const interrupted=isPrivate && privateInterrupted(isPrivate);
      return (
        <View style={item.id===messageTarget?{backgroundColor:c.surfaceActive}:undefined}><MessageRow
          c={c}
          message={item}
          client={client}
          sendStatus={protectedRoom?interrupted?'failed':isPrivate?.status==='accepted'?'pending':null:sendState?.status??null}
          failureLabel={interrupted?t(isPrivate.status==='cancelled'?'conversation.cancelled':'conversation.pending'):undefined}
          onRetry={(protectedRoom?interrupted && !conversation.busy:sendState?.status==='failed')?()=>retry(item.id):null}
          onDiscard={(protectedRoom?interrupted && isPrivate.status!=='cancelled' && !conversation.busy:sendState?.status==='failed')?discard:null}
          onLongPress={protectedRoom?isPrivate?.status==='journaled' && !isPrivate.amendment?openActions:null:sendState === undefined ? openActions : null}
          // We ARE in the thread: no "N replies" indicator on the root.
          onOpenThread={null}
          me={me}
          onReact={!protectedRoom && sendState === undefined ? react : null}
          continuation={continuations.has(item.id)}
          repeatedTime={repeatedTimes.has(item.id)}
        /></View>
      );
    },
    [c,client,outboxById,retry,discard,openActions,me,react,continuations,repeatedTimes,messageTarget,protectedRoom,conversation.view,conversation.busy,t],
  );

  const list = useRef<FlashListRef<MessageRowData | DayRow>>(null);
  const [listReady,setListReady]=useState(false);
  const revealedTarget=useRef<string|null>(null);
  useEffect(()=>{
    if(!listReady||!messageTarget||revealedTarget.current===messageTarget)return;
    const index=listData.findIndex(m=>!('day' in m)&&m.id===messageTarget);
    if(index<0)return;
    list.current?.scrollToIndex({index,animated:true,viewPosition:0.5});revealedTarget.current=messageTarget;
  },[listReady,messageTarget,listData]);
  // The list opens on the ROOT: without scrolling after sending, the optimistic
  // reply is born below the fold and the send seems to have done nothing. We
  // wait for the `_id` returned by `outbox.send` IN the data: it is the render
  // that readjusts the list, not a clock. The former `setTimeout(250)` lost
  // the race as soon as the write queue was busy: the chain SQLite write ->
  // `addDatabaseChangeListener` -> `useCoalescedLiveQuery` (debounce capped at
  // 400 ms) has NO guaranteed upper bound under that delay, and the project's
  // standing rule forbids fixes by waiting time.
  // A ref, not a state: "which send is waiting for its scroll" renders nothing.
  // `send` resolves on the local WRITE, and the projection of that write
  // necessarily arrives later (live query debounce >= 48 ms): the ref is
  // always set before the `data` change that consumes it.
  const sendToFollow = useRef<string | null>(null);
  const afterSend = useCallback((idMessage: string) => {
    sendToFollow.current = idMessage;
  }, []);
  useEffect(() => {
    if (sendToFollow.current === null) return;
    if (!data.some((m) => m.id === sendToFollow.current)) return;
    sendToFollow.current = null;
    list.current?.scrollToEnd({ animated: true });
  }, [data]);

  // Thread draft (8.7), key `rid:tmid`: isolated from the room's draft.
  // `null` while the rid is not known; the composer waits.
  const onInput=useCallback((active:boolean)=>{if(rid && !protectedRoom)void native?.chat.setTyping(rid,active,threadId,membership??undefined);},[native,rid,threadId,membership,protectedRoom]);
  const store=useMemo(()=>native?native.store.drafts({room:rid??'',membership:membership??null}):drafts,[native,drafts,rid,membership]);
  const ordinaryPersistence = useDraft(store, rid===undefined || protectedRoom || native && !room ? null : `${rid}:${threadId}`);
  const savePrivate=conversation.save;
  const clearPrivate=useCallback(()=>savePrivate(''),[savePrivate]);
  const persistence=protectedRoom?{initial:conversation.initial,save:conversation.save,clear:clearPrivate}:ordinaryPersistence;
  const linkedSend=useMemo<Outbox>(()=>protectedRoom?conversation.outbox:native?{...outboxQueue,send:(room,text,root,_attachments,quotes)=>{
    if(room!==rid || root!==threadId)throw Error('Thread unavailable in this composer');
    return quotesToSend(text,quotes);
  }}:outboxQueue,[native,outboxQueue,rid,threadId,protectedRoom,conversation.outbox,quotesToSend]);
  const request=useMemo(()=>new ObservedRead(async id=>{if(native && membership)await native.chat.markObservedThreadRead(threadId,id,membership);}),[native,membership,threadId]);
  useEffect(()=>()=>request.close(),[request]);
  useFocusEffect(useCallback(()=>{
    const active=()=>request.activate(!!native && !protectedRoom && membership!=null && AppState.currentState==='active');
    active();const listener=AppState.addEventListener('change',active);
    return()=>{listener.remove();request.activate(false);};
  },[request,native,membership,protectedRoom]));
  const onVisible=useCallback(({viewableItems}:{viewableItems:{item:MessageRowData|DayRow;index:number|null}[]})=>{
    const latest=viewableItems.filter(token=>!('day' in token.item) && token.item.threadId===threadId && !outboxById.has(token.item.id)).sort((a,b)=>(b.index??-1)-(a.index??-1))[0];
    if(latest && !('day' in latest.item))request.observer(latest.item.id);
  },[request,threadId,outboxById]);
  const viewability=useMemo(()=>({itemVisiblePercentThreshold:50}),[]);

  // Mention candidates (@): the ROOM's, not only the thread's; people often
  // mention in a thread someone who spoke in the main stream.
  // `rid` still unknown -> query on '': empty list, the composer is not
  // mounted anyway.
  const mentionCandidates = useMentionCandidates(base, rid ?? '');

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('thread.title') }} />
      {/* The header is native here (no `RoomHeader`): the bar therefore sits
          right below it. Without it, the thread rewrote itself entirely with
          no signal showing it. */}
      <SyncBar c={c} active={syncing} />
      {protectedRoom && <View style={styles.privateNotice}>
        <Text style={[styles.privateText,{color:c.dimmed}]}>{t(conversation.failed || !cryptoAvailable?'conversation.failed':conversation.view && !conversation.view.root?'conversation.rootMissing':'conversation.observed')}</Text>
        <Tappable onPress={conversation.reload} disabled={conversation.busy || !cryptoAvailable} accessibilityRole="button"><Text style={{color:c.cyan}}>{t('devices.refresh')}</Text></Tappable>
      </View>}
      {data.length === 0 ? (
        <View style={styles.center}>
          {(protectedRoom?conversation.view!==null || conversation.failed || !cryptoAvailable:firstPassDone) ? (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('thread.notFound')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={list}
          onLoad={()=>setListReady(true)}
          extraData={messageTarget}
          data={listData}
          keyExtractor={(m) => m.id}
          // Three templates (head with avatar / follow-up without / day
          // separator): typed so FlashList's recycling does not mix them.
          getItemType={(item) =>
            'day' in item ? 'day' : continuations.has(item.id) ? 'continuation' : 'message'
          }
          renderItem={renderRow}
          onViewableItemsChanged={native && !protectedRoom?onVisible:undefined}
          viewabilityConfig={native && !protectedRoom?viewability:undefined}
          contentContainerStyle={styles.content}
          // A thread is READ from its root: it opens at the top; the room's
          // INVERTED idiom (8.10) would make no sense here. So we keep mVCP to
          // follow incoming replies near the bottom, with its JS readjustment
          // during the keyboard animation: a short list, to port if the feel
          // demands it.
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2 }}
        />
      )}
      {/* The SHARED composer (ui/composer.tsx): the encrypted / read-only
          variants live inside it; in an encrypted room, it now offers the
          E2E unlock, like the room screen. `files` is null: no attachments
          or voice messages in a thread. */}
      {rid !== undefined && room !== undefined && persistence.initial !== null && (
        <Composer
          key={JSON.stringify([rid,threadId,membership,protectedRoom?conversation.view?.admission:null,protectedRoom?conversation.composer:null])}
          c={c}
          rid={rid}
          threadId={threadId}
          outbox={linkedSend}
          files={null}
          client={client}
          mentionCandidates={mentionCandidates}
          readOnly={protectedRoom?nativePermissions?.[0]?.canSend!==true || conversation.view?.can_send!==true || conversation.view.catching_up:room.readOnly || !!native && (membership==null || !root)}
          encrypted={room.encrypted}
          nativeEncryptedReady={protectedRoom && conversation.view!==null}
          availableQuotes={!protectedRoom || conversation.view!==null}
          placeholder={t('thread.reply')}
          afterSend={afterSend}
          initialDraft={persistence.initial}
          saveDraft={persistence.save}
          onInput={onInput}
          clearDraft={persistence.clear}
        />
      )}
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  privateNotice:{paddingHorizontal:16,paddingVertical:8,gap:4},
  privateText:{fontSize:12},
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 8 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14 },
  error: { fontFamily: FONTS.bodySemi, fontSize: 14, textAlign: 'center' },
});
