/**
 * "Reminders" (brain/features/reminders.md), reached from Settings: the
 * current account's reminders still to come, soonest first, read live from
 * the account's database (`reminders`, kept on the device). Each one: when,
 * the room (and "Thread reply"), the author and the excerpt. Tapping one
 * opens the message like a search result (`ui/messageJump.ts`, the thread
 * for a reply); "Cancel" removes it and its scheduled notification.
 */

import { asc } from 'drizzle-orm';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { reminders } from '../db/schema.ts';
import { useReminderFormatter, useT } from '../ui/i18n.ts';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { requestJump } from '../ui/messageJump.ts';
import { cancelReminder, exactAlarmsAllowed, openExactAlarmSettings } from '../ui/reminders.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { notify } from '../ui/toast.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';

export default function RemindersScreen() {
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('reminders.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  // Keyed by account: another account's list never shows under this one's.
  return <Reminders key={JSON.stringify(sync.provider.identity)} c={c} base={sync.base} />;
}

function Reminders({ c, base }: { c: Colors; base: LocalDatabase }) {
  const t = useT();
  const router = useRouter();
  const when = useReminderFormatter();
  const { data, loaded } = useCoalescedLiveQuery(base.select().from(reminders).orderBy(asc(reminders.dueAt)));
  // A due one leaves the list on its own: the reconciliation removes it, the
  // clock hides it meanwhile.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const pending = data.filter((r) => r.dueAt > now);
  // Re-read on return from the system's "Alarms and reminders" screen.
  const [exact, setExact] = useState(exactAlarmsAllowed);
  useEffect(() => {
    const state = AppState.addEventListener('change', (next) => {
      if (next === 'active') setExact(exactAlarmsAllowed());
    });
    return () => state.remove();
  }, []);
  const [busy, setBusy] = useState<string | null>(null);

  const open = (r: (typeof data)[number]) => {
    if (r.threadId !== null) {
      router.push({ pathname: '/thread/[id]', params: { id: r.threadId, rid: r.rid, message: r.messageId } });
      return;
    }
    requestJump(r.rid, { id: r.messageId });
    router.push({ pathname: '/room/[rid]', params: { rid: r.rid } });
  };
  const cancel = (messageId: string) => {
    if (busy !== null) return;
    setBusy(messageId);
    cancelReminder(messageId)
      .catch(() => notify(t('reminders.failed')))
      .finally(() => setBusy(null));
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('reminders.title') }} />
      {!exact && (
        <View style={[styles.late, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          <Text style={[styles.lateText, { color: c.text }]}>{t('reminders.exactLate')}</Text>
          <Tappable
            onPress={() => void openExactAlarmSettings()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, { borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.actionText, { color: c.accent }]}>{t('reminders.exactAllow')}</Text>
          </Tappable>
        </View>
      )}
      {loaded && pending.length === 0 ? (
        <Text style={[styles.empty, { color: c.dimmed }]}>{t('reminders.empty')}</Text>
      ) : (
        <FlatList
          data={pending}
          keyExtractor={(r) => r.messageId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={[styles.item, { backgroundColor: c.deepCard, borderColor: c.border }]}>
              <Tappable
                onPress={() => open(item)}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                accessibilityRole="button"
                accessibilityLabel={`${when(item.dueAt)}, ${item.roomName}, ${item.author}: ${item.excerpt}`}
                style={({ pressed }) => [styles.itemText, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.when, { color: c.accent }]}>{when(item.dueAt)}</Text>
                <Text style={[styles.room, { color: c.dimmed }]} numberOfLines={1}>
                  {item.threadId === null ? item.roomName : `${item.roomName} · ${t('reminders.threadReply')}`}
                </Text>
                <Text style={[styles.text, { color: c.text }]} numberOfLines={2}>
                  {item.author === '' ? item.excerpt : `${item.author}: ${item.excerpt}`}
                </Text>
              </Tappable>
              <Tappable
                onPress={() => cancel(item.messageId)}
                disabled={busy !== null}
                android_ripple={{ color: c.ripple }}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                style={[styles.action, { borderColor: c.border }, busy !== null && busy !== item.messageId && styles.inactive]}
              >
                {busy === item.messageId ? (
                  <ActivityIndicator size="small" color={c.accent} />
                ) : (
                  <Text style={[styles.actionText, { color: c.danger }]}>{t('common.cancel')}</Text>
                )}
              </Tappable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { fontFamily: FONTS.body, fontSize: 15, textAlign: 'center', paddingTop: 48, paddingHorizontal: 24 },
  list: { padding: 16, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingRight: 12, overflow: 'hidden' },
  itemText: { flex: 1, gap: 2, padding: 12 },
  when: { fontFamily: FONTS.bodySemi, fontSize: 13 },
  room: { fontFamily: FONTS.bodySemi, fontSize: 12.5 },
  text: { fontFamily: FONTS.body, fontSize: 15 },
  action: { minWidth: 84, alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  actionText: { fontFamily: FONTS.bodySemi, fontSize: 14 },
  inactive: { opacity: 0.4 },
  late: { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 16, marginBottom: 0, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14 },
  lateText: { flex: 1, fontFamily: FONTS.body, fontSize: 14 },
});
