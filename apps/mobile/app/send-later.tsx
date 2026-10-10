/**
 * "Send later" sheet (brain/features/scheduled-messages.md), a native
 * formSheet declared in `app/_layout.tsx`: In 1 hour, Tomorrow at 08:00, or
 * Pick a time (a day among the next 30 and an HH:MM time, the same typed
 * time field as the quiet hours of `ui/doNotDisturb.tsx`: no picker
 * dependency). The sheet only CHOOSES: it answers the composer
 * (`answerSendTime`), which schedules. A tap outside or Back closes it with
 * nothing scheduled.
 */

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { clock, minuteOf } from '../lib/quiet.ts';
import { atMinute, inOneHour, pickableDays, schedulable, tomorrowMorning } from '../lib/scheduled.ts';
import { useLanguage, useT, useTimeFormatter } from '../ui/i18n.ts';
import { answerSendTime } from '../ui/scheduled.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';

export default function SendLaterScreen() {
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const time = useTimeFormatter();
  const language = useLanguage();
  const bottomMargin = useSheetBottomMargin();
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      // Swiped away, Back or a tap outside: nothing scheduled.
      answerSendTime(null);
    };
  }, []);

  const [now] = useState(() => new Date());
  const days = useMemo(() => pickableDays(now), [now]);
  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' });
    return (day: Date) => format.format(day);
  }, [language]);
  // "Pick a time" starts an hour ahead, on that hour's day.
  const [picking, setPicking] = useState(false);
  const [dayIndex, setDayIndex] = useState(() => {
    const first = inOneHour(now);
    return days.findIndex((d) => d.getDate() === first.getDate() && d.getMonth() === first.getMonth());
  });
  const [typed, setTyped] = useState(() => {
    const first = inOneHour(now);
    return clock(first.getHours() * 60 + first.getMinutes());
  });
  const [error, setError] = useState(false);

  const choose = (at: Date) => {
    answerSendTime(at.getTime());
    if (open.current) router.back();
  };
  const confirmPicked = () => {
    const minute = minuteOf(typed);
    const day = days[dayIndex];
    const at = minute === null || day === undefined ? null : atMinute(day, minute);
    if (at === null || !schedulable(at, new Date())) {
      setError(true);
      return;
    }
    choose(at);
  };

  type Row = 'hour' | 'morning' | 'pick';
  const rows: { key: Row; label: string; hint: string }[] = [
    { key: 'hour', label: t('scheduled.inOneHour'), hint: time(inOneHour(now).getTime()) },
    { key: 'morning', label: t('scheduled.tomorrow'), hint: dayLabel(tomorrowMorning(now)) },
    { key: 'pick', label: t('scheduled.pickTime'), hint: '' },
  ];
  // The times are taken at the tap, not when the sheet opened.
  const press = (row: Row) => {
    if (row === 'hour') choose(inOneHour(new Date()));
    else if (row === 'morning') choose(tomorrowMorning(new Date()));
    else setPicking((v) => !v);
  };

  return (
    <View style={[styles.sheet, { paddingBottom: bottomMargin }]}>
      <Text style={[styles.title, { color: c.text }]}>{t('scheduled.sendLater')}</Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.rowWrapper}>
          <Tappable
            onPress={() => press(row.key)}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityState={row.key === 'pick' ? { expanded: picking } : undefined}
            accessibilityLabel={row.label}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.rowText, { color: c.text }]}>{row.label}</Text>
            {row.hint !== '' && <Text style={[styles.hint, { color: c.dimmed }]}>{row.hint}</Text>}
          </Tappable>
        </View>
      ))}
      {picking && (
        <View style={styles.picker}>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('scheduled.day')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.days}>
            {days.map((day, index) => (
              <Tappable
                key={day.getTime()}
                onPress={() => {
                  setDayIndex(index);
                  setError(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: index === dayIndex }}
                style={[styles.day, { borderColor: index === dayIndex ? c.accent : c.border, backgroundColor: index === dayIndex ? c.accent : 'transparent' }]}
              >
                <Text style={[styles.dayText, { color: index === dayIndex ? c.onAccent : c.text }]}>{dayLabel(day)}</Text>
              </Tappable>
            ))}
          </ScrollView>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('scheduled.time')}</Text>
          <TextInput
            value={typed}
            onChangeText={(text) => {
              setTyped(text);
              setError(false);
            }}
            onSubmitEditing={confirmPicked}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            accessibilityLabel={t('scheduled.time')}
            style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: error ? c.danger : c.border }]}
          />
          {error && <Text style={[styles.error, { color: c.errorText }]}>{t('scheduled.outOfRange')}</Text>}
          <Tappable
            onPress={confirmPicked}
            android_ripple={{ color: c.ripple }}
            accessibilityRole="button"
            accessibilityLabel={t('scheduled.confirm')}
            style={[styles.button, { backgroundColor: c.accent }]}
          >
            <Text style={[styles.buttonText, { color: c.onAccent }]}>{t('scheduled.confirm')}</Text>
          </Tappable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: 16, paddingTop: 14, gap: 2 },
  title: { fontFamily: FONTS.title, fontSize: 19, paddingHorizontal: 8, paddingBottom: 6 },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, paddingHorizontal: 8 },
  rowText: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 15.5 },
  hint: { fontFamily: FONTS.body, fontSize: 14 },
  picker: { gap: 8, paddingHorizontal: 8, paddingTop: 4 },
  label: { fontFamily: FONTS.bodySemi, fontSize: 13 },
  days: { gap: 8 },
  day: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  dayText: { fontFamily: FONTS.bodySemi, fontSize: 14 },
  field: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, width: 110 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: { alignItems: 'center', borderRadius: 14, paddingVertical: 13, marginTop: 4 },
  buttonText: { fontFamily: FONTS.bodyBold, fontSize: 15.5 },
});
