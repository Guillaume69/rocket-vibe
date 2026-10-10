import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { openProfileCard } from '../lib/profilePreload.ts';
import type { MemberPage, ProviderActions, RoomMember } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { useT } from '../ui/i18n.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import { presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';
import type { TranslationKey } from '../ui/messages.ts';

/**
 * A channel's or group's members (Rocket.Chat `rooms.membersOrderedByRole`):
 * owners and moderators first, a search the server runs, a page of 50 at a
 * time on scroll. Read from the server, not stored: the local database knows
 * the people who wrote, not the room's roster. A row opens the profile.
 */

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; members: RoomMember[]; total: number; more: boolean }
  | { phase: 'error' };

const ROLE_LABELS: Record<string, TranslationKey> = {
  owner: 'members.owner',
  moderator: 'members.moderator',
  leader: 'members.leader',
};

export default function RoomMembersScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string' || sync.actions.listMembers === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('members.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <Members c={c} client={state.client} actions={sync.actions} rid={rid} />;
}

function Members({ c, client, actions, rid }: { c: Colors; client: RestClient; actions: ProviderActions; rid: string }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  // The query the shown page answers, so a late answer to an older one is dropped.
  const asked = useRef('');
  const load = useCallback(
    (filter: string, offset: number): Promise<MemberPage | null> => {
      const list = actions.listMembers;
      if (list === undefined) return Promise.resolve(null);
      return list.call(actions, rid, filter, offset).then((page) => (asked.current === filter ? page : null));
    },
    [actions, rid],
  );

  useEffect(() => {
    const filter = query.trim();
    const timer = setTimeout(() => {
      asked.current = filter;
      setList({ phase: 'loading' });
      load(filter, 0).then(
        (page) => page !== null && setList({ phase: 'ready', members: page.members, total: page.total, more: false }),
        () => asked.current === filter && setList({ phase: 'error' }),
      );
    }, filter === '' ? 0 : 300);
    return () => clearTimeout(timer);
  }, [query, load]);

  const loadMore = useCallback(() => {
    if (list.phase !== 'ready' || list.more || list.members.length >= list.total) return;
    const filter = asked.current;
    setList({ ...list, more: true });
    load(filter, list.members.length).then(
      (page) =>
        page !== null &&
        setList((now) => {
          if (now.phase !== 'ready') return now;
          const known = new Set(now.members.map((m) => m.id));
          const fresh = page.members.filter((m) => !known.has(m.id));
          // A page with nothing new ends the list, or it would ask forever.
          return { phase: 'ready', members: [...now.members, ...fresh], total: fresh.length === 0 ? now.members.length : page.total, more: false };
        }),
      () => setList((now) => (now.phase === 'ready' ? { ...now, more: false } : now)),
    );
  }, [list, load]);

  const title = list.phase === 'ready' && query.trim() === '' ? t('members.count', { n: list.total }) : t('members.title');
  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('members.search')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
      </View>
      {list.phase === 'loading' ? (
        <ActivityIndicator style={styles.spinner} />
      ) : list.phase === 'error' ? (
        <Text style={[styles.empty, { color: c.errorText }]}>{t('members.loadFailed')}</Text>
      ) : (
        <FlatList
          data={list.members}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <MemberRow c={c} client={client} member={item} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={list.more ? <ActivityIndicator style={styles.spinner} /> : null}
          ListEmptyComponent={<Text style={[styles.empty, { color: c.dimmed }]}>{t('members.none')}</Text>}
          contentContainerStyle={styles.content}
        />
      )}
    </KeyboardAvoidingContainer>
  );
}

function MemberRow({ c, client, member }: { c: Colors; client: RestClient; member: RoomMember }) {
  const t = useT();
  const status = member.status as keyof ReturnType<typeof presenceColors> | null;
  const dot = status !== null && status in presenceColors(c) ? presenceColors(c)[status] : null;
  const roles = member.roles.flatMap((r) => (ROLE_LABELS[r] === undefined ? [] : [t(ROLE_LABELS[r])]));
  return (
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => void openProfileCard({ username: member.username })}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        accessibilityRole="button"
        style={styles.row}
      >
        <View>
          <AvatarTile
            c={c}
            hueKey={member.username}
            initial={(member.name ?? member.username).charAt(0)}
            uri={avatarUrl(client, { uid: member.id, username: member.username, etag: member.avatarEtag })}
          />
          {dot !== null && <View style={[styles.dot, { backgroundColor: dot, borderColor: c.background }]} />}
        </View>
        <View style={styles.body}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
            {member.name ?? member.username}
          </Text>
          <Text style={[styles.detail, { color: c.dimmed }]} numberOfLines={1}>
            @{member.username}
          </Text>
        </View>
        {roles.length > 0 && (
          <Text style={[styles.role, { color: c.accent, borderColor: c.accent }]}>{roles.join(' · ')}</Text>
        )}
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  dot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  body: { flex: 1, minWidth: 0, gap: 1 },
  name: { fontFamily: FONTS.bodySemi, fontSize: 16 },
  detail: { fontFamily: FONTS.body, fontSize: 13 },
  role: { fontFamily: FONTS.bodySemi, fontSize: 11.5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  spinner: { padding: 24 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
});
