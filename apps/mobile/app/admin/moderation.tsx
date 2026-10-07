import { Redirect, Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { BulkDeleteRequired, type AdminPerson, type AdminReport, type ProviderAdmin, type ReportedMessage, type ReportedUser } from '../../lib/admin.ts';
import {
  AdminGate,
  Badge,
  ItemAction,
  ListFooter,
  adminStyles,
  confirmAction,
  useAdminError,
  useAdminFormat,
  useAdminPages,
  useAdminRun,
  useLastOwnerConfirm,
} from '../../ui/adminKit.tsx';
import { useT } from '../../ui/i18n.ts';
import type { TranslationKey } from '../../ui/messages.ts';
import { useSession } from '../../ui/session.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { notify } from '../../ui/toast.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../../ui/theme.ts';

/**
 * Server administration, Moderation (`/admin/moderation`): the open reports,
 * in two tabs, reported messages and reported accounts, the most recently
 * reported first. Opening an item reads its reasons (lazily, when the list
 * did not carry them) and offers its actions: dismiss the reports, delete the
 * message, deactivate its author; or, for an account, dismiss and deactivate.
 * A handled item leaves the list.
 */

type Tab = 'messages' | 'users';

export default function AdminModerationScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  const [tab, setTab] = useState<Tab>('messages');
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.moderation') }} />
      <View style={[styles.tabs, { borderBottomColor: c.softBorder }]}>
        {(['messages', 'users'] as const).map((key) => (
          <Pressable key={key} onPress={() => setTab(key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === key }}>
            <Text style={[styles.tabText, { color: tab === key ? c.text : c.dimmed }]}>{t(key === 'messages' ? 'admin.tabMessages' : 'admin.tabUsers')}</Text>
            {tab === key && <View style={[styles.underline, { backgroundColor: c.accent }]} />}
          </Pressable>
        ))}
      </View>
      <AdminGate c={c}>
        {(admin) =>
          tab === 'messages' ? (
            <Messages c={c} admin={admin} me={state.session.userId} />
          ) : (
            <Users c={c} admin={admin} me={state.session.userId} />
          )
        }
      </AdminGate>
    </View>
  );
}

function Messages({ c, admin, me }: { c: Colors; admin: ProviderAdmin; me: string }) {
  const t = useT();
  const load = useCallback((after: string | null) => admin.reportedMessages(after), [admin]);
  const list = useAdminPages(load);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, setError, run } = useAdminRun();
  const lastOwner = useLastOwnerConfirm();
  const fmt = useAdminFormat();
  const drop = (item: ReportedMessage) => {
    list.setItems((items) => items.filter((m) => m.messageId !== item.messageId));
    setOpen(null);
  };
  const deactivate = (person: AdminPerson) =>
    confirmAction(t('admin.deactivateAuthor'), t('admin.deactivateBody', { name: person.name }), t('admin.deactivate'), t('common.cancel'),
      () => void run(async () => {
        if (await lastOwner((relinquish) => admin.deactivate(person, relinquish))) notify(t('admin.deactivated'));
      }, null));
  // A room the administrator is not in (Rocket.Chat): only the author-wide
  // moderation delete remains, asked for explicitly with its count.
  const remove = (item: ReportedMessage) =>
    confirmAction(t('admin.deleteMessage'), t('admin.deleteMessageBody'), t('common.delete'), t('common.cancel'),
      () => void run(async () => {
        try {
          await admin.deleteReportedMessage(item);
          drop(item);
          notify(t('admin.messageDeleted'));
        } catch (e) {
          const bulk = admin.deleteAuthorReportedMessages?.bind(admin);
          if (!(e instanceof BulkDeleteRequired) || bulk === undefined) throw e;
          confirmAction(
            t('admin.bulkDeleteTitle'),
            t('admin.bulkDeleteBody', { n: e.count ?? item.count }),
            t('admin.bulkDeleteConfirm'),
            t('common.cancel'),
            () => void run(async () => {
              await bulk(item);
              list.setItems((items) => items.filter((m) => m.author.id !== item.author.id));
              setOpen(null);
            }, 'admin.messagesDeleted'),
          );
        }
      }, null));
  return (
    <FlatList
      data={list.items}
      keyExtractor={(m) => m.messageId}
      contentContainerStyle={adminStyles.content}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[c.accent]} progressBackgroundColor={c.card} />}
      onEndReached={list.more}
      onEndReachedThreshold={0.5}
      ListFooterComponent={<ListFooter c={c} loading={list.loading} error={list.error} />}
      ListEmptyComponent={list.loading || list.error !== null ? null : <Text style={[adminStyles.empty, { color: c.dimmed }]}>{t('admin.noReports')}</Text>}
      renderItem={({ item }) => {
        const opened = open === item.messageId;
        return (
          <Tappable
            onPress={() => {
              setError(null);
              setOpen(opened ? null : item.messageId);
            }}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityState={{ expanded: opened }}
            style={[adminStyles.row, { backgroundColor: c.deepCard, borderColor: opened ? c.accent : c.border }]}
          >
            <View style={adminStyles.rowHead}>
              <View style={adminStyles.rowTexts}>
                <Text style={[adminStyles.title, { color: c.text }]} numberOfLines={1}>
                  {personName(item.author, t('common.deletedUser'))}
                </Text>
                <Text style={[adminStyles.sub, { color: c.dimmed }]} numberOfLines={1}>
                  {item.room.kind === 'direct' ? '💬' : item.room.kind === 'private' ? '🔒' : '#'} {item.room.name} · {fmt.date(item.createdAt)}
                </Text>
              </View>
              <Badge c={c} label={t('admin.reportCount', { n: item.count })} tone="danger" />
            </View>
            {item.deleted ? (
              <Badge c={c} label={t('admin.messageGone')} />
            ) : (
              item.encrypted ? (
                <Text style={[adminStyles.body, { color: c.dimmed }]}>🔒 {t('admin.encryptedMessage')}</Text>
              ) : (
                <Text style={[adminStyles.body, { color: c.messageText }]} numberOfLines={opened ? undefined : 3} selectable={opened}>{item.text}</Text>
              )
            )}
            <Text style={[adminStyles.sub, { color: c.dimmed }]}>{t('admin.latest', { date: fmt.date(item.latestAt) })}</Text>
            {opened && (
              <>
                <Reasons c={c} known={item.reports} read={() => admin.messageReports(item)} />
                <View style={adminStyles.actions}>
                  <ItemAction c={c} disabled={busy} label={t('admin.dismiss')}
                    onPress={() => void run(async () => { await admin.dismissMessageReports(item); drop(item); }, 'admin.dismissed')} />
                  {!item.deleted && (
                    <ItemAction c={c} disabled={busy} danger label={t('admin.deleteMessage')}
                      onPress={() => remove(item)} />
                  )}
                  {item.author.id !== me && !item.author.deleted && (
                    <ItemAction c={c} disabled={busy} danger label={t('admin.deactivateAuthor')} onPress={() => deactivate(item.author)} />
                  )}
                </View>
                {error !== null && <Text style={[adminStyles.sub, { color: c.errorText }]}>{t(error)}</Text>}
              </>
            )}
          </Tappable>
        );
      }}
    />
  );
}

function Users({ c, admin, me }: { c: Colors; admin: ProviderAdmin; me: string }) {
  const t = useT();
  const load = useCallback((after: string | null) => admin.reportedUsers(after), [admin]);
  const list = useAdminPages(load);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, setError, run } = useAdminRun();
  const lastOwner = useLastOwnerConfirm();
  const fmt = useAdminFormat();
  const drop = (item: ReportedUser) => {
    list.setItems((items) => items.filter((u) => u.user.id !== item.user.id));
    setOpen(null);
  };
  return (
    <FlatList
      data={list.items}
      keyExtractor={(u) => u.user.id}
      contentContainerStyle={adminStyles.content}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[c.accent]} progressBackgroundColor={c.card} />}
      onEndReached={list.more}
      onEndReachedThreshold={0.5}
      ListFooterComponent={<ListFooter c={c} loading={list.loading} error={list.error} />}
      ListEmptyComponent={list.loading || list.error !== null ? null : <Text style={[adminStyles.empty, { color: c.dimmed }]}>{t('admin.noReports')}</Text>}
      renderItem={({ item }) => {
        const opened = open === item.user.id;
        return (
          <Tappable
            onPress={() => {
              setError(null);
              setOpen(opened ? null : item.user.id);
            }}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityState={{ expanded: opened }}
            style={[adminStyles.row, { backgroundColor: c.deepCard, borderColor: opened ? c.accent : c.border }]}
          >
            <View style={adminStyles.rowHead}>
              <View style={adminStyles.rowTexts}>
                <Text style={[adminStyles.title, { color: c.text }]} numberOfLines={1}>{item.user.name}</Text>
                <Text style={[adminStyles.sub, { color: c.dimmed }]} numberOfLines={1}>@{item.user.username}</Text>
              </View>
              <Badge c={c} label={t('admin.reportCount', { n: item.count })} tone="danger" />
            </View>
            {item.active === false && <Badge c={c} label={t('admin.badgeDeactivated')} tone="danger" />}
            <Text style={[adminStyles.sub, { color: c.dimmed }]}>{t('admin.latest', { date: fmt.date(item.latestAt) })}</Text>
            {opened && (
              <>
                <Reasons c={c} known={item.reports} read={() => admin.userReports(item)} />
                <View style={adminStyles.actions}>
                  <ItemAction c={c} disabled={busy} label={t('admin.dismiss')}
                    onPress={() => void run(async () => { await admin.dismissUserReports(item); drop(item); }, 'admin.dismissed')} />
                  {item.user.id !== me && item.active !== false && (
                    <ItemAction c={c} disabled={busy} danger label={t('admin.deactivate')}
                      onPress={() => confirmAction(t('admin.deactivate'), t('admin.deactivateBody', { name: item.user.name }), t('admin.deactivate'), t('common.cancel'),
                        () => void run(async () => {
                          if (!(await lastOwner((relinquish) => admin.deactivate(item.user, relinquish)))) return;
                          list.setItems((items) => items.map((u) => (u.user.id === item.user.id ? { ...u, active: false } : u)));
                          notify(t('admin.deactivated'));
                        }, null))} />
                  )}
                </View>
                {error !== null && <Text style={[adminStyles.sub, { color: c.errorText }]}>{t(error)}</Text>}
              </>
            )}
          </Tappable>
        );
      }}
    />
  );
}

function personName(p: AdminPerson, deleted: string): string {
  return p.deleted ? deleted : p.name === p.username ? `@${p.username}` : `${p.name} · @${p.username}`;
}

/** The reasons of an opened item: given by the list, or read now. */
function Reasons({ c, known, read }: { c: Colors; known: AdminReport[] | null; read: () => Promise<AdminReport[]> }) {
  const t = useT();
  const fmt = useAdminFormat();
  const describe = useAdminError();
  const [reports, setReports] = useState<AdminReport[] | null>(known);
  const [error, setError] = useState<TranslationKey | null>(null);
  // Read once, when the item opens; the opened item keeps this component.
  const [ask] = useState(() => read);
  useEffect(() => {
    if (known !== null) return;
    let alive = true;
    ask().then(
      (r) => {
        if (alive) setReports(r);
      },
      (e: unknown) => {
        if (alive) setError(describe(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [known, ask, describe]);
  return (
    <View style={[styles.reasons, { borderColor: c.softBorder }]}>
      <Text style={[styles.reasonsTitle, { color: c.dimmed }]}>{t('admin.reasons')}</Text>
      {reports === null && error === null && <ActivityIndicator color={c.accent} />}
      {error !== null && <Text style={[adminStyles.sub, { color: c.errorText }]}>{t(error)}</Text>}
      {reports?.map((r, i) => (
        <View key={i} style={styles.reason}>
          <Text style={[adminStyles.body, { color: c.text }]} selectable>{r.reason}</Text>
          <Text style={[adminStyles.sub, { color: c.dimmed }]}>
            {r.reporter === null ? '—' : personName(r.reporter, t('common.deletedUser'))} · {fmt.date(r.at)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 8 },
  tabText: { fontFamily: FONTS.bodyStrong, fontSize: 14.5 },
  underline: { height: 2, width: 40, borderRadius: 1, marginTop: 6 },
  reasons: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 8 },
  reasonsTitle: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  reason: { gap: 2 },
});
