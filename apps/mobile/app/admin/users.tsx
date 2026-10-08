import { Redirect, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { AdminUser, ProviderAdmin } from '../../lib/admin.ts';
import type { RestClient } from '../../lib/rest.ts';
import { avatarUrl } from '../../lib/upload.ts';
import {
  AdminGate,
  Badge,
  ItemAction,
  ListFooter,
  SearchField,
  adminStyles,
  confirmAction,
  useAdminFormat,
  useAdminPages,
  useAdminRun,
  useDebounced,
  useLastOwnerConfirm,
} from '../../ui/adminKit.tsx';
import { useT } from '../../ui/i18n.ts';
import { AvatarTile } from '../../ui/kit.tsx';
import type { TranslationKey } from '../../ui/messages.ts';
import { presenceColors } from '../../ui/presence.ts';
import { useSession } from '../../ui/session.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { notify } from '../../ui/toast.tsx';
import { type Colors, LIST_PRESS_DELAY, useColors } from '../../ui/theme.ts';

/**
 * Server administration, Users (`/admin/users`): every account, searched and
 * paged by the server, with its avatar, name, badges (admin, deactivated,
 * bot), presence, creation and last activity. Tapping one opens its actions:
 * admin right (never granted to a RocketVibe bot), activation, deletion
 * (confirmed). My own row offers none: the
 * server refuses an administrator changing their own account anyway.
 */
export default function AdminUsersScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.users') }} />
      <AdminGate c={c}>{(admin) => <Users c={c} admin={admin} client={state.client} me={state.session.userId} />}</AdminGate>
    </View>
  );
}

function Users({ c, admin, client, me }: { c: Colors; admin: ProviderAdmin; client: RestClient; me: string }) {
  const t = useT();
  const fmt = useAdminFormat();
  const [query, setQuery] = useState('');
  const search = useDebounced(query);
  const load = useCallback((after: string | null) => admin.users(search, after), [admin, search]);
  const list = useAdminPages(load);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, setError, run } = useAdminRun();
  const lastOwner = useLastOwnerConfirm();

  const replace = (next: AdminUser) => list.setItems((items) => items.map((u) => (u.id === next.id ? next : u)));
  const change = (user: AdminUser, update: { admin?: boolean; active?: boolean }, done: TranslationKey) =>
    void run(async () => replace(await admin.updateUser(user, update)), done);
  const remove = (user: AdminUser) =>
    confirmAction(
      t('admin.deleteUserTitle', { username: user.username }),
      t(admin.product === 'rocketvibe' ? 'admin.deleteUserBodyNative' : 'admin.deleteUserBodyRc'),
      t('admin.deleteUser'),
      t('common.cancel'),
      () =>
        void run(async () => {
          // A last owner's rooms are named in a second confirmation (Rocket.Chat).
          if (!(await lastOwner((relinquish) => admin.deleteUser(user, relinquish)))) return;
          list.setItems((items) => items.filter((u) => u.id !== user.id));
          setOpen(null);
          notify(t('admin.userDeleted'));
        }, null),
    );
  const deactivate = (user: AdminUser) =>
    confirmAction(t('admin.deactivate'), t('admin.deactivateBody', { name: user.name }), t('admin.deactivate'), t('common.cancel'), () =>
      void run(async () => {
        let updated: AdminUser | null = null;
        if (!(await lastOwner(async (relinquish) => { updated = await admin.updateUser(user, { active: false }, relinquish); }))) return;
        if (updated !== null) replace(updated);
        notify(t('admin.deactivated'));
      }, null),
    );

  const dots = presenceColors(c);
  return (
    <FlatList
      data={list.items}
      keyExtractor={(u) => u.id}
      contentContainerStyle={adminStyles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[c.accent]} progressBackgroundColor={c.card} />}
      onEndReached={list.more}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={<SearchField c={c} value={query} onChange={setQuery} placeholder={t('admin.searchUsers')} />}
      ListFooterComponent={<ListFooter c={c} loading={list.loading} error={list.error} />}
      ListEmptyComponent={list.loading || list.error !== null ? null : <Text style={[adminStyles.empty, { color: c.dimmed }]}>{t('admin.empty')}</Text>}
      renderItem={({ item: user }) => {
        const mine = user.id === me;
        const opened = open === user.id;
        return (
          <Tappable
            onPress={() => {
              setError(null);
              setOpen(opened ? null : user.id);
            }}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityState={{ expanded: opened }}
            style={[adminStyles.row, { backgroundColor: c.deepCard, borderColor: opened ? c.accent : c.border }]}
          >
            <View style={adminStyles.rowHead}>
              <View>
                <AvatarTile c={c} hueKey={user.username} initial={(user.name || user.username).charAt(0)} size={40} radius={13}
                  uri={avatarUrl(client, user.avatar) ?? undefined} />
                <View style={[styles.presence, { backgroundColor: dots[user.status], borderColor: c.deepCard }]} />
              </View>
              <View style={adminStyles.rowTexts}>
                <Text style={[adminStyles.title, { color: c.text }]} numberOfLines={1}>{user.name}</Text>
                <Text style={[adminStyles.sub, { color: c.dimmed }]} numberOfLines={1}>@{user.username}</Text>
              </View>
            </View>
            <View style={adminStyles.badges}>
              {mine && <Badge c={c} label={t('admin.badgeYou')} tone="accent" />}
              {user.admin && <Badge c={c} label={t('admin.badgeAdmin')} tone="accent" />}
              {!user.active && <Badge c={c} label={t('admin.badgeDeactivated')} tone="danger" />}
              {user.bot && <Badge c={c} label={t('admin.badgeBot')} />}
            </View>
            {(user.createdAt !== null || user.lastSeenAt !== null) && (
              <Text style={[adminStyles.sub, { color: c.dimmed }]}>
                {[
                  user.createdAt === null ? null : t('admin.created', { date: fmt.date(user.createdAt) }),
                  user.lastSeenAt === null ? null : t('admin.lastSeen', { date: fmt.date(user.lastSeenAt) }),
                ].filter((part) => part !== null).join(' · ')}
              </Text>
            )}
            {opened && (mine ? (
              <Text style={[adminStyles.sub, { color: c.secondaryText }]}>{t('admin.myself')}</Text>
            ) : (
              <View style={adminStyles.actions}>
                {/* A RocketVibe bot never becomes an administrator (`bot_privilege`). */}
                {(user.admin || !(user.bot && admin.product === 'rocketvibe')) && (
                  <ItemAction c={c} disabled={busy} label={t(user.admin ? 'admin.removeAdmin' : 'admin.makeAdmin')}
                    onPress={() => change(user, { admin: !user.admin }, user.admin ? 'admin.adminRemoved' : 'admin.adminGranted')} />
                )}
                {user.active ? (
                  <ItemAction c={c} disabled={busy} label={t('admin.deactivate')} onPress={() => deactivate(user)} danger />
                ) : (
                  <ItemAction c={c} disabled={busy} label={t('admin.activate')} onPress={() => change(user, { active: true }, 'admin.activated')} />
                )}
                <ItemAction c={c} disabled={busy} label={t('admin.deleteUser')} onPress={() => remove(user)} danger />
              </View>
            ))}
            {opened && error !== null && <Text style={[adminStyles.sub, { color: c.errorText }]}>{t(error)}</Text>}
          </Tappable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  presence: { position: 'absolute', right: -2, bottom: -2, width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
});
