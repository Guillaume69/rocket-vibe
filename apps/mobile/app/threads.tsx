import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import type { LocalMessage } from '../lib/normalize.ts';
import type { ProviderActions } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import type { SyncEngine } from '../lib/sync.ts';
import { useT } from '../ui/i18n.ts';
import { MessageRow } from '../ui/messageRow.tsx';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';
import { FollowButton, useThreadFollow } from '../ui/threadFollow.tsx';

/**
 * A room's threads, latest reply first, all of them or the ones I follow
 * (Rocket.Chat `chat.getThreadsList`). Rendered from the provider like the
 * pinned and starred lists, a page at a time; each tab loads on its first
 * opening and again after a follow changed in the other. A row opens its
 * thread; its bell follows or unfollows it.
 */

type Tab = 'all' | 'following';

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; threads: LocalMessage[]; total: number; more: boolean }
  | { phase: 'error' };

export default function ThreadsScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();

  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('threads.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Threads
      c={c}
      client={state.client}
      actions={sync.actions}
      engine={sync.engine}
      rid={rid}
      me={state.session.username}
      myId={state.session.userId}
    />
  );
}

function Threads({
  c,
  client,
  actions,
  engine,
  rid,
  me,
  myId,
}: {
  c: Colors;
  client: RestClient;
  actions: ProviderActions;
  engine: SyncEngine;
  rid: string;
  me: string;
  myId: string;
}) {
  const t = useT();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [lists, setLists] = useState<Partial<Record<Tab, ListState>>>({});
  const requests = useRef(new Set<Tab>());

  const current = lists[tab];
  useEffect(() => {
    if (requests.current.has(tab) || actions.listThreads === undefined) return;
    requests.current.add(tab);
    const which = tab;
    actions.listThreads(rid, which === 'following', 0).then(
      ({ threads, total }) =>
        setLists((l) => ({ ...l, [which]: { phase: 'ready', threads, total, more: false } })),
      () => setLists((l) => ({ ...l, [which]: { phase: 'error' } })),
    );
  }, [tab, current, actions, rid]);

  const loadMore = useCallback(() => {
    const list = lists[tab];
    if (list?.phase !== 'ready' || list.more || list.threads.length >= list.total) return;
    if (actions.listThreads === undefined) return;
    const which = tab;
    setLists((l) => ({ ...l, [which]: { ...list, more: true } }));
    actions.listThreads(rid, which === 'following', list.threads.length).then(
      ({ threads, total }) =>
        setLists((l) => {
          const now = l[which];
          if (now?.phase !== 'ready') return l;
          const known = new Set(now.threads.map((m) => m.id));
          // A thread answered meanwhile moves up and shifts the pages: skip
          // what is already listed rather than show it twice.
          const fresh = threads.filter((m) => !known.has(m.id));
          // A page with nothing new ends the list, or it would ask forever.
          const end = fresh.length === 0 ? now.threads.length : total;
          return { ...l, [which]: { phase: 'ready', threads: [...now.threads, ...fresh], total: end, more: false } };
        }),
      () =>
        setLists((l) => {
          const now = l[which];
          return now?.phase === 'ready' ? { ...l, [which]: { ...now, more: false } } : l;
        }),
    );
  }, [lists, tab, actions, rid]);

  const reload = useCallback(() => {
    requests.current.delete(tab);
    setLists((l) => ({ ...l, [tab]: { phase: 'loading' } }));
  }, [tab]);

  // A follow changed here: the other tab's list no longer says the truth.
  const followed = useCallback(() => {
    const other: Tab = tab === 'all' ? 'following' : 'all';
    requests.current.delete(other);
    setLists((l) => {
      const { [other]: _dropped, ...rest } = l;
      return rest;
    });
  }, [tab]);

  const open = useCallback(
    (m: LocalMessage) => router.push({ pathname: '/thread/[id]', params: { id: m.id, rid } }),
    [router, rid],
  );

  return (
    <View style={[styles.full, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('threads.title') }} />
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['all', 'following'] as const).map((o) => {
          const active = o === tab;
          return (
            <Tappable
              key={o}
              onPress={() => setTab(o)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              android_ripple={{ color: c.ripple, borderless: false }}
              style={[
                styles.tab,
                {
                  borderColor: active ? c.accent : c.border,
                  backgroundColor: active ? c.surfaceActive : 'transparent',
                },
              ]}
            >
              <Text style={[styles.tabText, { color: active ? c.text : c.dimmed }]}>
                {t(o === 'all' ? 'threads.all' : 'threads.following')}
              </Text>
            </Tappable>
          );
        })}
      </View>
      {current === undefined || current.phase === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : current.phase === 'error' ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: c.errorText }]}>{t('threads.loadFailed')}</Text>
          <Tappable onPress={reload} hitSlop={8}>
            <Text style={[styles.retry, { color: c.accent }]}>{t('common.retry')}</Text>
          </Tappable>
        </View>
      ) : (
        <FlatList
          data={current.threads}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <ThreadRow
              c={c}
              message={item}
              client={client}
              actions={actions}
              engine={engine}
              me={me}
              myId={myId}
              onOpen={open}
              onFollowed={followed}
            />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={current.more ? <ActivityIndicator style={styles.more} /> : null}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: c.dimmed }]}>
              {t(tab === 'all' ? 'threads.none' : 'threads.noneFollowed')}
            </Text>
          }
          contentContainerStyle={styles.content}
        />
      )}
    </View>
  );
}

function ThreadRow({
  c,
  message,
  client,
  actions,
  engine,
  me,
  myId,
  onOpen,
  onFollowed,
}: {
  c: Colors;
  message: LocalMessage;
  client: RestClient;
  actions: ProviderActions;
  engine: SyncEngine;
  me: string;
  myId: string;
  onOpen: (m: LocalMessage) => void;
  onFollowed: () => void;
}) {
  const follow = useThreadFollow({
    actions,
    engine,
    rid: message.rid,
    root: message.id,
    followers: message.threadFollowers,
    myId,
  });
  return (
    <View style={styles.row}>
      <View style={styles.message}>
        <MessageRow
          c={c}
          message={message}
          client={client}
          sendStatus={null}
          onRetry={null}
          onDiscard={null}
          onLongPress={null}
          onPress={() => onOpen(message)}
          onOpenThread={() => onOpen(message)}
          me={me}
          onReact={null}
          continuation={false}
          repeatedTime={false}
        />
      </View>
      {follow !== null && (
        <FollowButton
          c={c}
          compact
          following={follow.following}
          busy={follow.busy}
          onPress={() => {
            follow.toggle();
            onFollowed();
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  tab: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  tabText: { fontFamily: FONTS.bodySemi, fontSize: 13.5 },
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8, paddingVertical: 4 },
  message: { flex: 1, minWidth: 0 },
  more: { padding: 16 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  retry: { fontFamily: FONTS.bodyBold, fontSize: 14 },
});
