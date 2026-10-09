import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { humanBytes, updateStatus, uptimeParts, type AdminOverview, type ProviderAdmin } from '../../lib/admin.ts';
import { AdminCard, AdminGate, ItemAction, StatLine, adminStyles, useAdminError, useAdminFormat } from '../../ui/adminKit.tsx';
import { useT } from '../../ui/i18n.ts';
import type { TranslationKey } from '../../ui/messages.ts';
import { PRESENCE_KEYS, presenceColors } from '../../ui/presence.ts';
import { useSession } from '../../ui/session.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../../ui/theme.ts';

/**
 * Server administration, the Dashboard (`/admin`): the deployment (version
 * and whether a newer release exists, uptime, database, migration, runtime,
 * instance) and the counts, then the rows to Moderation, Rooms and Users.
 * Reached from the settings list and a long press on the server's tile, both
 * shown to an administrator only (`ui/adminAccess.ts`); the server refuses
 * anyone else anyway.
 */

const PRODUCTS = { rocketchat: 'Rocket.Chat', rocketvibe: 'RocketVibe' } as const;
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export default function AdminScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.title') }} />
      <AdminGate c={c}>{(admin) => <Dashboard c={c} admin={admin} />}</AdminGate>
    </View>
  );
}

function Dashboard({ c, admin }: { c: Colors; admin: ProviderAdmin }) {
  const t = useT();
  const router = useRouter();
  const describe = useAdminError();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Read once for the screen's life: GitHub is asked once, not on each pull.
  const [latest, setLatest] = useState<string | null>(null);

  // Bumped by a pull: reads the overview again.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let alive = true;
    // The first read takes the server's cached figures (Rocket.Chat's
    // `statistics`); only a pull or the Refresh button asks fresh ones.
    admin
      .overview(reads > 0)
      .then(
        (o) => {
          if (!alive) return;
          setOverview(o);
          setError(null);
        },
        (e: unknown) => {
          if (alive) setError(describe(e));
        },
      )
      .finally(() => {
        if (alive) setRefreshing(false);
      });
    return () => {
      alive = false;
    };
  }, [admin, describe, reads]);

  useEffect(() => {
    let alive = true;
    void admin.latestVersion().then((v) => {
      if (alive) setLatest(v);
    });
    return () => {
      alive = false;
    };
  }, [admin]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setReads((n) => n + 1);
  }, []);

  const units = t('admin.byteUnits').split(',');
  const reports = overview === null ? 0 : (overview.reports.messages ?? 0) + (overview.reports.users ?? 0);

  return (
    <ScrollView
      contentContainerStyle={adminStyles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.accent]} progressBackgroundColor={c.card} />}
    >
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(error)}</Text>}
      {overview === null && error === null && <ActivityIndicator color={c.accent} style={styles.loading} />}
      {overview !== null && <Cards c={c} o={overview} latest={latest} units={units} refreshing={refreshing} onRefresh={refresh} onReports={() => router.push('/admin/moderation')} />}
      {admin.userBots !== undefined && <BotSetting c={c} admin={admin} />}

      <View style={[styles.list, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <NavRow c={c} icon="🛡️" label={t('admin.moderation')} hint={t('admin.moderationHint')} count={reports} first onPress={() => router.push('/admin/moderation')} />
        <NavRow c={c} icon="#️⃣" label={t('admin.rooms')} hint={t('admin.roomsHint')} onPress={() => router.push('/admin/rooms')} />
        <NavRow c={c} icon="👥" label={t('admin.users')} hint={t('admin.usersHint')} onPress={() => router.push('/admin/users')} />
        {admin.canManageEmojis?.() === true && (
          <NavRow c={c} icon="😀" label={t('admin.emoji')} hint={t('admin.emojiHint')} onPress={() => router.push('/admin/emoji')} />
        )}
      </View>
    </ScrollView>
  );
}

function Cards({ c, o, latest, units, refreshing, onRefresh, onReports }: { c: Colors; o: AdminOverview; latest: string | null; units: string[]; refreshing: boolean; onRefresh: () => void; onReports: () => void }) {
  const t = useT();
  const fmt = useAdminFormat();
  const status = updateStatus(o.version, latest);
  const up = o.uptimeSeconds === null ? null : uptimeParts(o.uptimeSeconds);
  const dots = presenceColors(c);
  const n = fmt.number;
  return (
    <>
      {o.asOf !== null && (
        <View style={styles.asOf}>
          <Text style={[styles.asOfText, { color: c.dimmed }]}>{t('admin.asOf', { date: fmt.dateTime(o.asOf) })}</Text>
          <ItemAction c={c} disabled={refreshing} label={t('admin.refresh')} onPress={onRefresh} />
        </View>
      )}
      <AdminCard c={c} title={t('admin.deployment')}>
        <StatLine c={c} label={PRODUCTS[o.product]} value={o.version} strong />
        {status !== null && (
          <Text style={[styles.update, { color: status === 'available' ? c.yellow : c.online }]}>
            {status === 'available' ? t('admin.updateAvailable', { version: latest ?? '' }) : t('admin.upToDate')}
          </Text>
        )}
        {up !== null && <StatLine c={c} label={t('admin.uptime')} value={up.days > 0 ? t('admin.uptimeValue', { d: up.days, h: up.hours, m: up.minutes }) : t('admin.uptimeHours', { h: up.hours, m: up.minutes })} />}
        <StatLine c={c} label={t('admin.database')} value={o.database} />
        {o.migration !== null && <StatLine c={c} label={t('admin.migration')} value={o.migration} />}
        {o.runtime !== null && <StatLine c={c} label={t('admin.runtime')} value={o.runtime} />}
        {o.instanceId !== null && <StatLine c={c} label={t('admin.instance')} value={o.instanceId} />}
      </AdminCard>

      <AdminCard c={c} title={t('admin.users')}>
        <StatLine c={c} label={t('admin.total')} value={n(o.users.total)} strong />
        <StatLine c={c} label={t('admin.active')} value={n(o.users.active)} />
        <StatLine c={c} label={t('admin.deactivatedCount')} value={n(o.users.deactivated)} />
        {o.users.admins !== null && <StatLine c={c} label={t('admin.admins')} value={n(o.users.admins)} />}
        {(['online', 'away', 'busy', 'offline'] as const).map((p) => (
          <StatLine key={p} c={c} dot={dots[p]} label={capitalize(t(PRESENCE_KEYS[p]))} value={n(o.users[p])} />
        ))}
      </AdminCard>

      <AdminCard c={c} title={t('admin.rooms')}>
        <StatLine c={c} label={t('admin.total')} value={n(o.rooms.total)} strong />
        <StatLine c={c} label={t('admin.public')} value={n(o.rooms.public)} />
        <StatLine c={c} label={t('admin.private')} value={n(o.rooms.private)} />
        <StatLine c={c} label={t('admin.direct')} value={n(o.rooms.direct)} />
        {o.rooms.discussions !== null && <StatLine c={c} label={t('admin.discussions')} value={n(o.rooms.discussions)} />}
        {o.rooms.encrypted !== null && <StatLine c={c} label={t('admin.encrypted')} value={n(o.rooms.encrypted)} />}
      </AdminCard>

      <AdminCard c={c} title={t('admin.messages')}>
        <StatLine c={c} label={t('admin.total')} value={n(o.messages.total)} strong />
        <StatLine c={c} label={t('admin.public')} value={n(o.messages.public)} />
        <StatLine c={c} label={t('admin.private')} value={n(o.messages.private)} />
        <StatLine c={c} label={t('admin.direct')} value={n(o.messages.direct)} />
        {o.messages.discussions !== null && <StatLine c={c} label={t('admin.discussions')} value={n(o.messages.discussions)} />}
        {o.messages.encrypted !== null && <StatLine c={c} label={t('admin.encrypted')} value={n(o.messages.encrypted)} />}
      </AdminCard>

      <AdminCard c={c} title={t('admin.uploads')}>
        <StatLine c={c} label={t('admin.uploadCount', { n: o.uploads.count, count: n(o.uploads.count) })} value={humanBytes(o.uploads.bytes, units)} strong />
      </AdminCard>

      <Tappable onPress={onReports} android_ripple={{ color: c.ripple }} unstable_pressDelay={LIST_PRESS_DELAY} accessibilityRole="button">
        <AdminCard c={c} title={t('admin.reports')}>
          <StatLine c={c} label={t('admin.reportedMessages')} value={n(o.reports.messages)} />
          <StatLine c={c} label={t('admin.reportedUsers')} value={n(o.reports.users)} />
          <Text style={[styles.link, { color: c.cyan }]}>{t('admin.openModeration')} ›</Text>
        </AdminCard>
      </Tappable>
    </>
  );
}

/**
 * RocketVibe with bots (RFC 0003): the instance switch that opens bot creation
 * to every account. Hidden on Rocket.Chat and on a server without bots; the
 * switch shows the server's answer, never an unconfirmed state.
 */
function BotSetting({ c, admin }: { c: Colors; admin: ProviderAdmin }) {
  const t = useT();
  const describe = useAdminError();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    admin.userBots?.().then(
      (value) => { if (alive.current) setOn(value); },
      (e: unknown) => { if (alive.current) setError(describe(e)); },
    );
    return () => {
      alive.current = false;
    };
  }, [admin, describe]);
  const change = (next: boolean) => {
    if (busy || admin.setUserBots === undefined) return;
    setBusy(true);
    setError(null);
    admin.setUserBots(next).then(
      (value) => { if (alive.current) setOn(value); },
      (e: unknown) => { if (alive.current) setError(describe(e)); },
    ).finally(() => { if (alive.current) setBusy(false); });
  };
  if (on === null && error === null) return null;
  return (
    <AdminCard c={c} title={t('admin.bots')}>
      {on !== null && (
        <View style={styles.toggle}>
          <Text style={[styles.toggleLabel, { color: c.text }]}>{t('admin.userBots')}</Text>
          <Switch accessibilityLabel={t('admin.userBots')} value={on} disabled={busy} onValueChange={change} />
        </View>
      )}
      <Text style={[styles.help, { color: c.dimmed }]}>{t('admin.userBotsHint')}</Text>
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(error)}</Text>}
    </AdminCard>
  );
}

function NavRow({ c, icon, label, hint, count, first = false, onPress }: { c: Colors; icon: string; label: string; hint: string; count?: number; first?: boolean; onPress: () => void }) {
  return (
    <Tappable
      onPress={onPress}
      android_ripple={{ color: c.ripple }}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={adminStyles.icon}>{icon}</Text>
      <View style={adminStyles.rowTexts}>
        <Text style={[adminStyles.title, { color: c.text }]}>{label}</Text>
        <Text style={[adminStyles.sub, { color: c.dimmed }]} numberOfLines={1}>{hint}</Text>
      </View>
      {count !== undefined && count > 0 && (
        <View style={[styles.count, { backgroundColor: c.yellow }]}>
          <Text style={[styles.countText, { color: c.background }]}>{count}</Text>
        </View>
      )}
      <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 24 },
  error: { fontFamily: FONTS.bodyBold, fontSize: 13.5 },
  update: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  asOf: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  asOfText: { flex: 1, fontFamily: FONTS.body, fontSize: 12.5 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 13.5, marginTop: 2 },
  list: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13, paddingHorizontal: 16 },
  count: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  countText: { fontFamily: FONTS.bodyStrong, fontSize: 12.5 },
  chevron: { fontFamily: FONTS.title, fontSize: 24 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 14 },
  help: { fontFamily: FONTS.body, fontSize: 12.5, lineHeight: 17 },
});
