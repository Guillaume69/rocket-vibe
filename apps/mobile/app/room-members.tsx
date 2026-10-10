import { eq } from 'drizzle-orm';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { rooms, subscriptions } from '../db/schema.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';

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
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';

/**
 * A channel's or group's members (Rocket.Chat `rooms.membersOrderedByRole`):
 * owners and moderators first, a search the server runs, a page of 50 at a
 * time on scroll. Read from the server, not stored: the local database knows
 * the people who wrote, not the room's roster. A row opens the profile; a
 * long press unfolds what my rights allow on that member (`set-moderator`,
 * `set-owner`, `remove-user`, from my global and room roles): an Android alert
 * holds three buttons, too few for these and Cancel.
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
  return <Members c={c} client={state.client} actions={sync.actions} base={sync.base} rid={rid} myId={state.session.userId} />;
}

function Members({
  c,
  client,
  actions,
  base,
  rid,
  myId,
}: {
  c: Colors;
  client: RestClient;
  actions: ProviderActions;
  base: LocalDatabase;
  rid: string;
  myId: string;
}) {
  const t = useT();
  const { data: roomRows } = useCoalescedLiveQuery(base.select({ type: rooms.type }).from(rooms).where(eq(rooms.rid, rid)), [rid]);
  const { data: subscriptionRows } = useCoalescedLiveQuery(
    base.select({ roles: subscriptions.roles }).from(subscriptions).where(eq(subscriptions.rid, rid)),
    [rid],
  );
  const type = roomRows?.[0]?.type ?? null;
  const myRoles = subscriptionRows?.[0]?.roles ?? null;
  const [granted, setGranted] = useState<readonly string[]>([]);
  useEffect(() => {
    if (client.kind !== 'rocketchat') return;
    let alive = true;
    sourcesPermissions(client).then(
      (sources) => alive && setGranted(grantedPermissions(sources, roomRoles(myRoles))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, myRoles]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The roles changed here, shown at once: the list is not live.
  const patch = useCallback((id: string, change: (m: RoomMember) => RoomMember | null) => {
    setList((now) =>
      now.phase !== 'ready'
        ? now
        : { ...now, members: now.members.flatMap((m) => (m.id !== id ? [m] : (change(m) ?? []))), total: now.total },
    );
  }, []);
  const act = useCallback(
    (run: () => Promise<void> | undefined, after: () => void) => {
      if (busy) return;
      const going = run();
      if (going === undefined) return;
      setBusy(true);
      going.then(
        () => {
          after();
          setOpen(null);
        },
        () => Alert.alert(t('members.actionFailed'), undefined, [{ text: t('common.close') }], { cancelable: true }),
      ).finally(() => setBusy(false));
    },
    [busy, t],
  );
  const toggleRole = (m: RoomMember, role: 'moderator' | 'owner') => {
    const put = !m.roles.includes(role);
    act(
      () => (type === null ? undefined : actions.setMemberRole?.(rid, type, m.id, role, put)),
      () => patch(m.id, (x) => ({ ...x, roles: put ? [...x.roles, role] : x.roles.filter((r) => r !== role) })),
    );
  };
  const remove = (m: RoomMember) =>
    Alert.alert(t('members.removeTitle', { name: m.name ?? m.username }), t('members.removeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('members.remove'),
        style: 'destructive',
        onPress: () =>
          act(
            () => (type === null ? undefined : actions.removeMember?.(rid, type, m.id)),
            () => {
              patch(m.id, () => null);
              setList((now) => (now.phase === 'ready' ? { ...now, total: Math.max(0, now.total - 1) } : now));
            },
          ),
      },
    ], { cancelable: true });
  const can = {
    moderator: granted.includes('set-moderator') && actions.setMemberRole !== undefined,
    owner: granted.includes('set-owner') && actions.setMemberRole !== undefined,
    remove: granted.includes('remove-user') && actions.removeMember !== undefined,
  };
  const anything = can.moderator || can.owner || can.remove;
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
          renderItem={({ item }) => (
            <View>
              <MemberRow
                c={c}
                client={client}
                member={item}
                onLongPress={anything && item.id !== myId ? () => setOpen(open === item.id ? null : item.id) : undefined}
              />
              {open === item.id && (
                <View style={styles.actions}>
                  {can.moderator && (
                    <ActionChip c={c} busy={busy} label={t(item.roles.includes('moderator') ? 'members.unsetModerator' : 'members.setModerator')} onPress={() => toggleRole(item, 'moderator')} />
                  )}
                  {can.owner && (
                    <ActionChip c={c} busy={busy} label={t(item.roles.includes('owner') ? 'members.unsetOwner' : 'members.setOwner')} onPress={() => toggleRole(item, 'owner')} />
                  )}
                  {can.remove && <ActionChip c={c} busy={busy} danger label={t('members.remove')} onPress={() => remove(item)} />}
                </View>
              )}
            </View>
          )}
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

function ActionChip({ c, label, onPress, busy, danger = false }: { c: Colors; label: string; onPress: () => void; busy: boolean; danger?: boolean }) {
  return (
    <Tappable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      android_ripple={{ color: c.ripple }}
      style={[styles.chip, { borderColor: danger ? c.errorText : c.border, opacity: busy ? 0.6 : 1 }]}
    >
      <Text style={[styles.chipText, { color: danger ? c.errorText : c.text }]}>{label}</Text>
    </Tappable>
  );
}

function MemberRow({ c, client, member, onLongPress }: { c: Colors; client: RestClient; member: RoomMember; onLongPress?: () => void }) {
  const t = useT();
  const status = member.status as keyof ReturnType<typeof presenceColors> | null;
  const dot = status !== null && status in presenceColors(c) ? presenceColors(c)[status] : null;
  const roles = member.roles.flatMap((r) => (ROLE_LABELS[r] === undefined ? [] : [t(ROLE_LABELS[r])]));
  return (
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => void openProfileCard({ username: member.username })}
        onLongPress={onLongPress}
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 72, paddingBottom: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, overflow: 'hidden' },
  chipText: { fontFamily: FONTS.bodySemi, fontSize: 13 },
  spinner: { padding: 24 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
});
