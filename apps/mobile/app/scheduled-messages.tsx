/**
 * A room's scheduled messages of mine (brain/features/scheduled-messages.md),
 * opened from the composer's "N scheduled" chip; a native formSheet declared
 * in `app/_layout.tsx`. Each one: when it leaves, its text, Cancel; a failed
 * one says why and offers Remove. Read again on open and after each cancel;
 * a tap outside closes it with nothing cancelled.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { ScheduledItem } from '../lib/scheduled.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { useScheduleFormatter, useT } from '../ui/i18n.ts';
import { refreshScheduled, scheduledAvailable, scheduledReason, useScheduledList } from '../ui/scheduled.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { notify } from '../ui/toast.tsx';
import { FONTS, useColors } from '../ui/theme.ts';

export default function ScheduledMessagesScreen() {
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const when = useScheduleFormatter();
  const bottomMargin = useSheetBottomMargin();
  const { height } = useWindowDimensions();
  const { rid: param } = useLocalSearchParams<{ rid?: string }>();
  const rid = typeof param === 'string' ? param : '';
  const sync = useSync();
  const provider = sync.phase === 'ready' ? sync.provider : null;
  const items = useScheduledList(provider, rid);
  const [busy, setBusy] = useState<string | null>(null);
  const open = useRef(true);
  const shown = useRef(false);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    void refreshScheduled(provider, rid);
  }, [provider, rid]);
  // The last one cancelled: nothing left to show.
  useEffect(() => {
    if (items.length > 0) shown.current = true;
    else if (shown.current && open.current) router.back();
  }, [items.length, router]);

  const cancel = (item: ScheduledItem) => {
    if (!scheduledAvailable(provider) || busy !== null) return;
    setBusy(item.id);
    void provider.scheduled
      .cancel(item.id)
      .catch((e: unknown) => {
        // Gone already (sent meanwhile): the refresh below shows it.
        if (e instanceof NativeError && e.status === 404) return;
        notify(t(e instanceof NativeError && e.code === 'scheduled_sending' ? 'scheduled.sending' : 'scheduled.cancelFailed'));
      })
      .then(() => refreshScheduled(provider, rid))
      .finally(() => {
        if (open.current) setBusy(null);
      });
  };

  return (
    <View style={[styles.sheet, { paddingBottom: bottomMargin }]}>
      <Text style={[styles.title, { color: c.text }]}>{t('scheduled.title')}</Text>
      <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={styles.list}>
        {items.map((item) => (
          <View key={item.id} style={[styles.item, { borderColor: c.border }]}>
            <View style={styles.itemText}>
              <Text style={[styles.when, { color: item.failed ? c.errorText : c.dimmed }]}>
                {item.failed ? `${t('scheduled.failed')} · ${scheduledReason(item.error, t)}` : when(item.sendAt)}
              </Text>
              {item.threadId !== null && <Text style={[styles.thread, { color: c.dimmed }]}>{t('scheduled.threadReply')}</Text>}
              <Text style={[styles.text, { color: c.text }]} numberOfLines={2}>
                {item.text}
              </Text>
            </View>
            <Tappable
              onPress={() => cancel(item)}
              disabled={busy !== null}
              android_ripple={{ color: c.ripple }}
              accessibilityRole="button"
              accessibilityLabel={t(item.failed ? 'scheduled.remove' : 'common.cancel')}
              style={[styles.action, { borderColor: c.border }, busy !== null && busy !== item.id && styles.inactive]}
            >
              {busy === item.id ? (
                <ActivityIndicator size="small" color={c.accent} />
              ) : (
                <Text style={[styles.actionText, { color: item.failed ? c.text : c.danger }]}>
                  {t(item.failed ? 'scheduled.remove' : 'common.cancel')}
                </Text>
              )}
            </Tappable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: 16, paddingTop: 14 },
  title: { fontFamily: FONTS.title, fontSize: 19, paddingHorizontal: 8, paddingBottom: 8 },
  list: { gap: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12 },
  itemText: { flex: 1, gap: 2 },
  when: { fontFamily: FONTS.bodySemi, fontSize: 13 },
  thread: { fontFamily: FONTS.body, fontSize: 12 },
  text: { fontFamily: FONTS.body, fontSize: 15 },
  action: { minWidth: 84, alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  actionText: { fontFamily: FONTS.bodySemi, fontSize: 14 },
  inactive: { opacity: 0.4 },
});
