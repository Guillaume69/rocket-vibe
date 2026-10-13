import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { rooms } from '../db/schema.ts';
import type { ActivityMessage } from '../db/store.ts';
import { activityFeed, type ActivityFeed, type ActivityItem } from '../lib/activityFeed.ts';
import { unicodeOfShortcode } from '../lib/emojis.ts';
import { textPreview } from '../lib/markdown.ts';
import { stripQuotePrefix } from '../lib/quote.ts';
import { useListTimeFormatter, useT } from '../ui/i18n.ts';
import { roomTitle, useDisplayNames, useIdentities } from '../ui/identities.tsx';
import { UnreadBadge } from '../ui/kit.tsx';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { readActivity } from '../ui/localSearch.ts';
import { requestJump } from '../ui/messageJump.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';

/**
 * Activity: what happened to me in the open account, from this device only
 * (`ui/localSearch.ts`, no server call). First the rooms whose server counts
 * more unread mentions than the list shows for them, then the mentions, the replies in
 * my threads and the reactions to my messages, newest first
 * (`lib/activityFeed.ts`). A tap opens the room at the message, or the thread
 * of a reply that lives there, like the local search. Re-read on each focus.
 * WhatsApp has no entry: no mentions, no threads, reactors are phone ids.
 */

type RoomRecord = typeof rooms.$inferSelect;
type MentionRoom = { rid: string; mentions: number; lastActivity: number | null };
type Feed = ActivityFeed<ActivityMessage, MentionRoom>;
type Row = { kind: 'room'; room: MentionRoom } | { kind: 'item'; item: ActivityItem<ActivityMessage> };
type Section = { key: string; title: string; data: Row[] };

export default function ActivityScreen() {
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (state.phase !== 'connected' || sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('activity.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  const { userId, username, kind } = state.session;
  return <Activity c={c} base={sync.base} me={{ userId, username }} none={kind === 'whatsapp'} />;
}

function Activity({ c, base, me, none }: { c: Colors; base: LocalDatabase; me: { userId: string; username: string }; none: boolean }) {
  const t = useT();
  const router = useRouter();
  const names = useDisplayNames();
  const identities = useIdentities();
  const listTime = useListTimeFormatter();
  const { data: roomRows } = useCoalescedLiveQuery(base.select().from(rooms));
  const [feed, setFeed] = useState<Feed | null>(null);

  const { userId, username } = me;
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (none) setFeed({ rooms: [], items: [] });
      else
        void readActivity(userId)
          .then((source) => {
            if (active) setFeed(activityFeed({ ...source, me: { userId, username } }));
          })
          .catch(() => {
            if (active) setFeed({ rooms: [], items: [] });
          });
      return () => {
        active = false;
      };
    }, [none, userId, username]),
  );

  const byRid = useMemo(() => new Map<string, RoomRecord>(roomRows.map((r) => [r.rid, r])), [roomRows]);
  const title = (rid: string): string => {
    const room = byRid.get(rid);
    return room === undefined ? '…' : roomTitle(room, names);
  };
  // Reactions name people by username; the shown name is keyed by uid.
  const uidOf = useMemo(() => new Map([...identities].map(([uid, name]) => [name, uid])), [identities]);
  const person = (name: string): string => {
    const uid = uidOf.get(name);
    return (uid === undefined ? undefined : names.get(uid)) ?? name;
  };
  const author = (m: ActivityMessage): string => names.get(m.authorId) ?? identities.get(m.authorId) ?? m.authorName ?? '?';

  const open = useCallback(
    (m: ActivityMessage) => {
      if (m.threadId !== null && !m.threadShown) {
        router.push({ pathname: '/thread/[id]', params: { id: m.threadId, rid: m.rid, message: m.id } });
        return;
      }
      requestJump(m.rid, { id: m.id });
      router.push({ pathname: '/room/[rid]', params: { rid: m.rid } });
    },
    [router],
  );

  if (feed === null) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('activity.title') }} />
        <ActivityIndicator />
      </View>
    );
  }

  const sections: Section[] = [];
  if (feed.rooms.length > 0) {
    sections.push({ key: 'rooms', title: t('activity.rooms'), data: feed.rooms.map((room) => ({ kind: 'room', room })) });
  }
  if (feed.items.length > 0) {
    sections.push({ key: 'items', title: t('activity.recent'), data: feed.items.map((item) => ({ kind: 'item', item })) });
  }

  const what = (item: ActivityItem<ActivityMessage>): string => {
    switch (item.kind) {
      case 'mention':
        return t('activity.mention');
      case 'reply':
        return t('activity.reply');
      case 'reaction':
        return t('activity.reaction', {
          names: item.reactors.map(person).join(', '),
          emojis: item.emojis.map((code) => unicodeOfShortcode(code) ?? `:${code}:`).join(' '),
        });
    }
  };

  return (
    <View style={[styles.full, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('activity.title') }} />
      <SectionList<Row, Section>
        sections={sections}
        keyExtractor={(row) => (row.kind === 'room' ? `room:${row.room.rid}` : `item:${row.item.message.id}`)}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionHeader, { color: c.dimmed, backgroundColor: c.background }]}>{section.title}</Text>
        )}
        stickySectionHeadersEnabled={false}
        renderItem={({ item: row }) => {
          if (row.kind === 'room') {
            const { room } = row;
            return (
              <View style={styles.rowWrapper}>
                <Tappable
                  onPress={() => router.push({ pathname: '/room/[rid]', params: { rid: room.rid } })}
                  android_ripple={{ color: c.ripple }}
                  unstable_pressDelay={LIST_PRESS_DELAY}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.row, styles.roomRow, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <View style={styles.rowBody}>
                    <Text style={[styles.primary, { color: c.text }]} numberOfLines={1}>
                      {title(room.rid)}
                    </Text>
                    <Text style={[styles.secondary, { color: c.dimmed }]} numberOfLines={1}>
                      {t('activity.room_mentions', { n: room.mentions })}
                    </Text>
                  </View>
                  <UnreadBadge c={c} n={room.mentions} mentioned />
                </Tappable>
              </View>
            );
          }
          const { item } = row;
          const m = item.message;
          // No text left (a locked one is never an item): attachments only, as the reply banner says it.
          const excerpt = m.text === null ? t('common.attachment') : textPreview(stripQuotePrefix(m.text));
          return (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => open(m)}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
              >
                <View style={styles.rowTop}>
                  <Text style={[styles.primary, styles.what, { color: c.text }]} numberOfLines={1}>
                    {what(item)}
                  </Text>
                  <Text style={[styles.time, { color: c.dimmed }]}>{listTime(m.ts)}</Text>
                </View>
                <Text style={[styles.secondary, { color: c.dimmed }]} numberOfLines={1}>
                  {item.kind === 'reaction' ? title(m.rid) : `${title(m.rid)} · ${author(m)}`}
                </Text>
                {excerpt !== '' && (
                  <Text style={[styles.excerpt, { color: c.secondaryText }]} numberOfLines={1}>
                    {excerpt}
                  </Text>
                )}
              </Tappable>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={[styles.empty, { color: c.dimmed }]}>{t('activity.empty')}</Text>}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  sectionHeader: {
    fontFamily: FONTS.bodySemi,
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 6,
  },
  // The radius lives on the wrapper: its clip rounds the ripple (see `app/index.tsx`).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  roomRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  what: { flex: 1 },
  primary: { fontFamily: FONTS.bodySemi, fontSize: 15 },
  secondary: { fontFamily: FONTS.body, fontSize: 13 },
  excerpt: { fontFamily: FONTS.body, fontSize: 14 },
  time: { fontFamily: FONTS.body, fontSize: 12 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
});
