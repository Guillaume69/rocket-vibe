/**
 * Settings > Notifications, "Do not disturb", on a Vibez account
 * (brain/features/do-not-disturb.md), as the web offers it: a mute for one
 * hour or until 08:00, and daily quiet hours (a switch and two HH:MM times,
 * 22:00 to 08:00 by default, saved with the phone's IANA time zone). The
 * server holds push and call rings back while quiet; the card shows the state
 * with `quietNow` (`lib/quiet.ts`).
 *
 * Each save sends ONLY the field it changes (`preferencesInput`,
 * providers/vibez/profileOperations.ts): the other one stays absent, so
 * the server keeps it. No modal: chips, a native switch and two text fields.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { DEFAULT_QUIET, clock, minuteOf, mutedUntil, nextMorning, quietNow, validWindow } from '../lib/quiet.ts';
import { dayKey } from './daySeparator.ts';
import { useDayFormatter, useT, useTimeFormatter } from './i18n.ts';
import { Icon } from './icon.tsx';
import { PillField } from './kit.tsx';
import type { useNativePreferences } from './nativePreferences.ts';
import { Tappable } from './tappable.tsx';
import { type Colors, FONTS } from './theme.ts';
import { deviceTimeZone } from './workflowsModel.ts';

type Natives = ReturnType<typeof useNativePreferences>;

/** Now, again every 30 s: the "until" and "on right now" lines follow the clock. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function DoNotDisturbCard({ c, natives }: { c: Colors; natives: Natives }) {
  const t = useT();
  const time = useTimeFormatter();
  const day = useDayFormatter();
  const now = useNow();
  const p = natives.preferences;
  const disabled = p === null || natives.busy || natives.intention !== null;
  const until = mutedUntil(p, now);
  const morning = nextMorning(now);
  const mute = (instant: Date | null) => void natives.change({ muted_until: instant === null ? null : instant.toISOString() });
  const window = p?.quiet_hours ?? null;
  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <View style={styles.row}>
        <Icon name="notifications-disabled" size={18} color={c.dimmed} />
        <Text style={[styles.title, styles.grow, { color: c.text }]}>{t('settings.dnd')}</Text>
      </View>
      <Text style={[styles.help, { color: c.dimmed }]}>{t('settings.dndHelp')}</Text>
      {quietNow(p, now) && <Text style={[styles.state, { color: c.accent }]}>{t('settings.dndNow')}</Text>}

      <View style={styles.row}>
        <Text style={[styles.label, styles.grow, { color: c.text }]}>{t('settings.mute')}</Text>
        <Text style={[styles.value, { color: c.secondaryText }]}>
          {until === null
            ? t('settings.dndOff')
            : dayKey(until.getTime()) === dayKey(now.getTime())
              ? t('settings.muteUntil', { time: time(until.getTime()) })
              : t('settings.muteUntilDay', { day: day(until.getTime()), time: time(until.getTime()) })}
        </Text>
      </View>
      <View style={styles.chips}>
        <Chip c={c} disabled={disabled} label={t('settings.muteHour')} onPress={() => mute(new Date(Date.now() + 3_600_000))} />
        <Chip c={c} disabled={disabled} label={t('settings.muteUntil', { time: time(morning.getTime()) })} onPress={() => mute(nextMorning(new Date()))} />
        {until !== null && <Chip c={c} disabled={disabled} label={t('settings.unmute')} onPress={() => mute(null)} />}
      </View>

      {/* Keyed by the stored window: a save (or another device's) resets the drafts. */}
      <QuietHoursRows key={window === null ? 'off' : `${window.start_minute}-${window.end_minute}-${window.time_zone}`} c={c} natives={natives} disabled={disabled} />
    </View>
  );
}

function QuietHoursRows({ c, natives, disabled }: { c: Colors; natives: Natives; disabled: boolean }) {
  const t = useT();
  const window = natives.preferences?.quiet_hours ?? null;
  const [from, setFrom] = useState(() => clock(window?.start_minute ?? DEFAULT_QUIET.start_minute));
  const [to, setTo] = useState(() => clock(window?.end_minute ?? DEFAULT_QUIET.end_minute));
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [invalid, setInvalid] = useState(false);
  const on = natives.busy && wanted !== null ? wanted : window !== null;
  /** Saves the window the fields hold, in the phone's zone; null turns it off. */
  const save = (enabled: boolean) => {
    if (!enabled) {
      setInvalid(false);
      setWanted(false);
      void natives.change({ quiet_hours: null });
      return;
    }
    const start = minuteOf(from), end = minuteOf(to);
    if (start === null || end === null || !validWindow(start, end)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const zone = deviceTimeZone();
    if (window !== null && window.start_minute === start && window.end_minute === end && window.time_zone === zone) return;
    setWanted(true);
    void natives.change({ quiet_hours: { start_minute: start, end_minute: end, time_zone: zone } });
  };
  return (
    <>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={[styles.label, { color: c.text }]}>{t('settings.quietHours')}</Text>
          <Text style={[styles.help, { color: c.dimmed }]}>
            {window === null ? t('settings.dndOff') : t('settings.quietEvery', { from: clock(window.start_minute), to: clock(window.end_minute), zone: window.time_zone })}
          </Text>
        </View>
        <Switch
          value={on}
          disabled={disabled}
          onValueChange={save}
          trackColor={{ true: c.accent }}
          accessibilityLabel={t('settings.quietHours')}
        />
      </View>
      {on && (
        <View style={styles.times}>
          <View style={styles.grow}>
            <PillField c={c} label={t('settings.quietFrom')} value={from} editable={!disabled} maxLength={5} keyboardType="numbers-and-punctuation"
              onChangeText={setFrom} onEndEditing={() => save(true)} />
          </View>
          <View style={styles.grow}>
            <PillField c={c} label={t('settings.quietTo')} value={to} editable={!disabled} maxLength={5} keyboardType="numbers-and-punctuation"
              onChangeText={setTo} onEndEditing={() => save(true)} />
          </View>
        </View>
      )}
      {invalid && <Text style={[styles.error, { color: c.errorText }]}>{t('settings.quietInvalid')}</Text>}
    </>
  );
}

function Chip({ c, label, disabled, onPress }: { c: Colors; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Tappable
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      android_ripple={{ color: c.ripple }}
      style={[styles.chip, { borderColor: c.border, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.chipText, { color: c.cyan }]}>{label}</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1 },
  title: { fontFamily: FONTS.title, fontSize: 16 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  state: { fontFamily: FONTS.bodyStrong, fontSize: 13 },
  label: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  value: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7, overflow: 'hidden' },
  chipText: { fontFamily: FONTS.bodyStrong, fontSize: 13 },
  times: { flexDirection: 'row', gap: 12 },
  error: { fontFamily: FONTS.bodyBold, fontSize: 13 },
});
