import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import type { ProviderActions } from '../lib/provider.ts';
import type { MessageLocal } from '../lib/normalize.ts';
import type { ClientRest } from '../lib/rest.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useT } from '../ui/i18n.ts';
import { DaySeparator } from '../ui/kit.tsx';
import { MessageRow } from '../ui/messageRow.tsx';
import { requestJump } from '../ui/messageJump.ts';
import { dayKey } from '../ui/daySeparator.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

/**
 * Messages épinglés du salon et mes favoris (étoilés) dans ce salon. Comme la
 * recherche, les listes sont ÉPHÉMÈRES : rendues depuis la réponse REST, jamais
 * écrites en base. Chaque onglet ne se charge qu'à sa première ouverture — une
 * requête par onglet et par visite, sur une route limitée à 10 par minute.
 * Toucher un message referme l'écran et fait défiler le salon jusqu'à lui
 * (`ui/messageJump.ts`) ; une réponse de fil ouvre son fil.
 */

type Tab = 'pinned' | 'starred';

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: MessageLocal[] }
  | { phase: 'error' };

export default function MarkedMessagesScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();

  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('marques.titre') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <MarkedMessages
      c={c}
      client={state.client}
      actions={sync.actions}
      rid={rid}
      me={state.session.username}
    />
  );
}

function MarkedMessages({
  c,
  client,
  actions,
  rid,
  me,
}: {
  c: Colors;
  client: ClientRest;
  actions: ProviderActions;
  rid: string;
  me: string;
}) {
  const t = useT();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('pinned');
  const [lists, setLists] = useState<Partial<Record<Tab, ListState>>>({});

  const current = lists[tab];
  const requests = useRef(new Set<Tab>());
  useEffect(() => {
    if (requests.current.has(tab)) return;
    requests.current.add(tab);
    const which = tab;
    (which === 'pinned' ? actions.listPinned(rid) : actions.listStarred(rid)).then(
      (messages) => setLists((l) => ({ ...l, [which]: { phase: 'ready', messages } })),
      () => setLists((l) => ({ ...l, [which]: { phase: 'error' } })),
    );
  }, [tab, current, actions, rid]);

  const open = useCallback(
    (m: MessageLocal) => {
      router.back();
      if (m.threadId !== null && !m.threadShown) {
        router.push({ pathname: '/thread/[id]', params: { id: m.threadId } });
        return;
      }
      requestJump(rid, { id: m.id, ts: m.ts });
    },
    [router, rid],
  );

  const reload = useCallback(() => {
    requests.current.delete(tab);
    setLists((l) => ({ ...l, [tab]: { phase: 'loading' } }));
  }, [tab]);

  return (
    <View style={[styles.full, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('marques.titre') }} />
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['pinned', 'starred'] as const).map((o) => {
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
                {t(o === 'pinned' ? 'marques.epingles' : 'marques.favoris')}
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
          <Text style={[styles.empty, { color: c.errorText }]}>{t('marques.chargementImpossible')}</Text>
          <Tappable onPress={reload} hitSlop={8}>
            <Text style={[styles.retry, { color: c.accent }]}>{t('commun.reessayer')}</Text>
          </Tappable>
        </View>
      ) : (
        <FlatList
          data={current.messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item, index }) => (
            <View style={styles.result}>
              {(index === 0 ||
                dayKey(current.messages[index - 1].ts) !== dayKey(item.ts)) && (
                <DaySeparator c={c} ts={item.ts} />
              )}
              <MessageRow
                c={c}
                message={item}
                client={client}
                sendStatus={null}
                onRetry={null}
                onDiscard={null}
                onLongPress={null}
                onPress={() => open(item)}
                onOpenThread={null}
                me={me}
                onReact={null}
                continuation={false}
                repeatedTime={false}
              />
            </View>
          )}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: c.dimmed }]}>
              {t(tab === 'pinned' ? 'marques.aucunEpingle' : 'marques.aucunFavori')}
            </Text>
          }
          contentContainerStyle={styles.content}
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
  result: { paddingHorizontal: 8, paddingVertical: 4 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  retry: { fontFamily: FONTS.bodyBold, fontSize: 14 },
});
