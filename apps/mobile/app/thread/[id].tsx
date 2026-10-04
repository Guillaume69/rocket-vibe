import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { asc, eq } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../../ui/liveQuery.ts';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../../db/client.ts';
import type { DraftStore } from '../../db/store.ts';
import { messages, rooms, outbox } from '../../db/schema.ts';
import type { ActivityEngine } from '../../lib/activity.ts';
import type { ProviderActions, Provider, Listener, Outbox } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { SyncEngine } from '../../lib/sync.ts';
import { useActivity } from '../../ui/activity.ts';
import { useDraft } from '../../ui/drafts.ts';
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
  const { id } = useLocalSearchParams<{ id: string }>();
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
    <Thread
      c={c}
      threadId={id}
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
}: {
  c: Colors;
  threadId: string;
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
}) {
  const t = useT();
  const syncing = useActivity(threadId);
  // The thread root: it carries the title and the `rid`.
  const { data: rootRows } = useCoalescedLiveQuery(
    base.select().from(messages).where(eq(messages.id, threadId)).limit(1),
    [threadId],
  );
  const root = rootRows?.[0];

  const { data: replyRows } = useCoalescedLiveQuery(
    base
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      // Secondary key `id` (same reason as the room screen): a tie to the
      // millisecond is broken deterministically, not by insertion order. ASC
      // order here to stay consistent with the room's DESC sort: two linked
      // messages keep the same relation in both views.
      .orderBy(asc(messages.ts), asc(messages.id)),
    [threadId],
  );

  // `rid`: from the root, or FAILING THAT from a reply (cold direct link;
  // `chat.getThreadMessages` never returns the root, but every reply carries
  // the rid). Without this fallback, the screen could neither subscribe to the
  // stream nor reply until the root has arrived.
  const rid = root?.rid ?? (replyRows ?? [])[0]?.rid;

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
  const { data: outboxRows } = useCoalescedLiveQuery(
    base.select().from(outbox).where(eq(outbox.threadId, threadId)),
    [threadId],
  );
  const outboxById = useMemo(
    () => new Map((outboxRows ?? []).map((s) => [s.id, s])),
    [outboxRows],
  );

  // Root first, replies in chronological order: a thread reads from the top.
  const data = useMemo<MessageRowData[]>(() => {
    const responses = replyRows ?? [];
    return root === undefined ? responses : [root, ...responses];
  }, [root, replyRows]);

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
  }, [provider, engine, threadId, generation, activity]);

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
      router.push({ pathname: '/message-actions', params: { id: idMessage, thread: threadId } });
    },
    [router, threadId],
  );
  const retry = useCallback(() => {
    outboxQueue.process().catch(() => {});
  }, [outboxQueue]);
  const discard = useCallback(
    (idMessage: string) => {
      outboxQueue.discard(idMessage).catch(() => {});
    },
    [outboxQueue],
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
      return (
        <MessageRow
          c={c}
          message={item}
          client={client}
          sendStatus={sendState?.status ?? null}
          onRetry={sendState?.status === 'failed' ? retry : null}
          onDiscard={sendState?.status === 'failed' ? discard : null}
          onLongPress={sendState === undefined ? openActions : null}
          // We ARE in the thread: no "N replies" indicator on the root.
          onOpenThread={null}
          me={me}
          onReact={sendState === undefined ? react : null}
          continuation={continuations.has(item.id)}
          repeatedTime={repeatedTimes.has(item.id)}
        />
      );
    },
    [c, client, outboxById, retry, discard, openActions, me, react, continuations, repeatedTimes],
  );

  const list = useRef<FlashListRef<MessageRowData | DayRow>>(null);
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
  const persistence = useDraft(drafts, rid === undefined ? null : `${rid}:${threadId}`);

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
      {data.length === 0 ? (
        <View style={styles.center}>
          {firstPassDone ? (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('thread.notFound')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={list}
          data={listData}
          keyExtractor={(m) => m.id}
          // Three templates (head with avatar / follow-up without / day
          // separator): typed so FlashList's recycling does not mix them.
          getItemType={(item) =>
            'day' in item ? 'day' : continuations.has(item.id) ? 'continuation' : 'message'
          }
          renderItem={renderRow}
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
          key={`${rid}:${threadId}`}
          c={c}
          rid={rid}
          threadId={threadId}
          outbox={outboxQueue}
          files={null}
          client={client}
          mentionCandidates={mentionCandidates}
          readOnly={room.readOnly}
          encrypted={room.encrypted}
          placeholder={t('thread.reply')}
          afterSend={afterSend}
          initialDraft={persistence.initial}
          saveDraft={persistence.save}
          clearDraft={persistence.clear}
        />
      )}
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 8 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14 },
  error: { fontFamily: FONTS.bodySemi, fontSize: 14, textAlign: 'center' },
});
