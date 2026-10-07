import { Redirect, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';

import type { AdminRoom, AdminRoomKind, ProviderAdmin } from '../../lib/admin.ts';
import {
  AdminGate,
  Badge,
  ListFooter,
  SearchField,
  adminStyles,
  useAdminFormat,
  useAdminPages,
  useDebounced,
} from '../../ui/adminKit.tsx';
import { useT } from '../../ui/i18n.ts';
import type { TranslateFn } from '../../ui/messages.ts';
import { useSession } from '../../ui/session.tsx';
import { type Colors, useColors } from '../../ui/theme.ts';

/**
 * Server administration, Rooms (`/admin/rooms`): every room of the server,
 * direct conversations included (named by their members), searched and paged
 * by the server. Read only: the type, the counts, the creation, and the
 * read-only and encrypted marks. An administrator reads no conversation from
 * here.
 */

const ICONS: Record<AdminRoomKind, string> = { public: '#️⃣', private: '🔒', direct: '💬', discussion: '🧵' };

/** A native direct conversation by its pair, a deleted member as "Deleted user". */
function roomName(room: AdminRoom, t: TranslateFn): string {
  if (room.directMembers === undefined) return room.name;
  return room.directMembers.map((m) => (m.deleted ? t('common.deletedUser') : m.name)).join(', ');
}

export default function AdminRoomsScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.rooms') }} />
      <AdminGate c={c}>{(admin) => <Rooms c={c} admin={admin} />}</AdminGate>
    </View>
  );
}

function Rooms({ c, admin }: { c: Colors; admin: ProviderAdmin }) {
  const t = useT();
  const fmt = useAdminFormat();
  const [query, setQuery] = useState('');
  const search = useDebounced(query);
  const load = useCallback((after: string | null) => admin.rooms(search, after), [admin, search]);
  const list = useAdminPages(load);
  return (
    <FlatList
      data={list.items}
      keyExtractor={(r) => r.id}
      contentContainerStyle={adminStyles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[c.accent]} progressBackgroundColor={c.card} />}
      onEndReached={list.more}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={<SearchField c={c} value={query} onChange={setQuery} placeholder={t('admin.searchRooms')} />}
      ListFooterComponent={<ListFooter c={c} loading={list.loading} error={list.error} />}
      ListEmptyComponent={list.loading || list.error !== null ? null : <Text style={[adminStyles.empty, { color: c.dimmed }]}>{t('admin.empty')}</Text>}
      renderItem={({ item: room }) => (
        <View style={[adminStyles.row, { backgroundColor: c.deepCard, borderColor: c.border }]} accessible>
          <View style={adminStyles.rowHead}>
            <Text style={adminStyles.icon}>{ICONS[room.kind]}</Text>
            <View style={adminStyles.rowTexts}>
              <Text style={[adminStyles.title, { color: c.text }]} numberOfLines={1}>{roomName(room, t)}</Text>
              {room.topic !== null && <Text style={[adminStyles.sub, { color: c.dimmed }]} numberOfLines={1}>{room.topic}</Text>}
            </View>
          </View>
          <Text style={[adminStyles.sub, { color: c.secondaryText }]}>
            {t('admin.memberCount', { n: room.members, count: fmt.number(room.members) })} · {t('admin.messageCount', { n: room.messages, count: fmt.number(room.messages) })}
          </Text>
          {(room.createdAt !== null || room.lastMessageAt !== null) && (
            <Text style={[adminStyles.sub, { color: c.dimmed }]}>
              {[
                room.createdAt === null ? null : t('admin.created', { date: fmt.date(room.createdAt) }),
                room.lastMessageAt === null ? null : t('admin.lastMessage', { date: fmt.date(room.lastMessageAt) }),
              ].filter((part) => part !== null).join(' · ')}
            </Text>
          )}
          {(room.readOnly || room.encrypted) && (
            <View style={adminStyles.badges}>
              {room.readOnly && <Badge c={c} label={t('admin.badgeReadOnly')} />}
              {room.encrypted && <Badge c={c} label={t('admin.badgeEncrypted')} tone="accent" />}
            </View>
          )}
        </View>
      )}
    />
  );
}
