/**
 * "Remind me" sheet (brain/features/reminders.md), a native formSheet
 * declared in `app/_layout.tsx`, opened from the message sheet
 * (`app/message-actions.tsx`, which arms the message with `armReminder`): In
 * 1 hour, In 3 hours, Tomorrow at 09:00, or Pick a time. Picking is the
 * approach of `app/send-later.tsx` stretched to a year: a day stepper (a day
 * or a month at a time, kept between today and a year ahead) and an HH:MM
 * field typed like the quiet hours, no picker dependency. Choosing stores the
 * reminder on the device (`setReminder`) and says when it fires. A tap
 * outside or Back closes it with nothing set.
 */

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { clock, minuteOf } from '../lib/quiet.ts';
import { atMinute } from '../lib/scheduled.ts';
import { addDays, addMonths, clampDay, inHours, remindable, startOfDay, tomorrowAt } from '../lib/reminders.ts';
import { useLanguage, useReminderFormatter, useT, useTimeFormatter } from '../ui/i18n.ts';
import { armedReminder, setReminder, type ReminderDraft } from '../ui/reminders.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { Tappable } from '../ui/tappable.tsx';
import { notify } from '../ui/toast.tsx';
import { FONTS, LIST_PRESS_DELAY, useColors, type Colors } from '../ui/theme.ts';

/** "Tomorrow at 09:00": the hour the spec names. */
const MORNING = 9;

export default function RemindMeScreen() {
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const time = useTimeFormatter();
  const when = useReminderFormatter();
  const language = useLanguage();
  const bottomMargin = useSheetBottomMargin();
  // Read once: the draft belongs to the message the sheet was opened for.
  const [draft] = useState<ReminderDraft | null>(() => armedReminder());
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  // No message armed (the account changed meanwhile): nothing to remind of.
  useEffect(() => {
    if (draft === null) router.back();
  }, [draft, router]);

  const [now] = useState(() => new Date());
  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return (day: Date) => format.format(day);
  }, [language]);
  // "Pick a time" starts an hour ahead, on that hour's day.
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState(() => startOfDay(inHours(now, 1)));
  const [typed, setTyped] = useState(() => {
    const first = inHours(now, 1);
    return clock(first.getHours() * 60 + first.getMinutes());
  });
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = (at: Date) => {
    if (draft === null || busy) return;
    setBusy(true);
    setReminder(draft, at.getTime()).then(
      ({ notifies }) => {
        notify(notifies ? t('reminders.set', { when: when(at.getTime()) }) : t('reminders.notificationsOff'));
        if (open.current) router.back();
      },
      () => {
        notify(t('reminders.failed'));
        if (open.current) setBusy(false);
      },
    );
  };
  const confirmPicked = () => {
    const minute = minuteOf(typed);
    const at = minute === null ? null : atMinute(day, minute);
    if (at === null || !remindable(at, new Date())) {
      setError(true);
      return;
    }
    choose(at);
  };
  const step = (move: (d: Date) => Date) => {
    setDay((d) => clampDay(move(d), new Date()));
    setError(false);
  };

  type Row = 'hour' | 'three' | 'morning' | 'pick';
  const rows: { key: Row; label: string; hint: string }[] = [
    { key: 'hour', label: t('reminders.inOneHour'), hint: time(inHours(now, 1).getTime()) },
    { key: 'three', label: t('reminders.inThreeHours'), hint: time(inHours(now, 3).getTime()) },
    { key: 'morning', label: t('reminders.tomorrow'), hint: dayLabel(tomorrowAt(now, MORNING)) },
    { key: 'pick', label: t('reminders.pickTime'), hint: '' },
  ];
  // The times are taken at the tap, not when the sheet opened.
  const press = (row: Row) => {
    if (row === 'hour') choose(inHours(new Date(), 1));
    else if (row === 'three') choose(inHours(new Date(), 3));
    else if (row === 'morning') choose(tomorrowAt(new Date(), MORNING));
    else setPicking((v) => !v);
  };

  if (draft === null) return null;
  return (
    <View style={[styles.sheet, { paddingBottom: bottomMargin }]}>
      <Text style={[styles.title, { color: c.text }]}>{t('reminders.remindMe')}</Text>
      <Text style={[styles.excerpt, { color: c.dimmed }]} numberOfLines={2}>
        {draft.author === '' ? draft.excerpt : `${draft.author}: ${draft.excerpt}`}
      </Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.rowWrapper}>
          <Tappable
            onPress={() => press(row.key)}
            disabled={busy}
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
          <Text style={[styles.label, { color: c.dimmed }]}>{t('reminders.day')}</Text>
          <View style={styles.stepper}>
            <StepButton c={c} label="«" hint={t('reminders.previousMonth')} onPress={() => step((d) => addMonths(d, -1))} />
            <StepButton c={c} label="‹" hint={t('reminders.previousDay')} onPress={() => step((d) => addDays(d, -1))} />
            <Text style={[styles.dayText, { color: c.text }]} numberOfLines={1} accessibilityLiveRegion="polite">
              {dayLabel(day)}
            </Text>
            <StepButton c={c} label="›" hint={t('reminders.nextDay')} onPress={() => step((d) => addDays(d, 1))} />
            <StepButton c={c} label="»" hint={t('reminders.nextMonth')} onPress={() => step((d) => addMonths(d, 1))} />
          </View>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('reminders.time')}</Text>
          <TextInput
            value={typed}
            onChangeText={(text) => {
              setTyped(text);
              setError(false);
            }}
            onSubmitEditing={confirmPicked}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            accessibilityLabel={t('reminders.time')}
            style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: error ? c.danger : c.border }]}
          />
          {error && <Text style={[styles.error, { color: c.errorText }]}>{t('reminders.outOfRange')}</Text>}
          <Tappable
            onPress={confirmPicked}
            disabled={busy}
            android_ripple={{ color: c.ripple }}
            accessibilityRole="button"
            accessibilityLabel={t('reminders.confirm')}
            style={[styles.button, { backgroundColor: c.accent }]}
          >
            <Text style={[styles.buttonText, { color: c.onAccent }]}>{t('reminders.confirm')}</Text>
          </Tappable>
        </View>
      )}
    </View>
  );
}

/**
 * One step of the day stepper: a typographic chevron (a day) or guillemet (a
 * month), the way the settings rows draw their chevron; read out by its hint.
 */
function StepButton({ c, label, hint, onPress }: { c: Colors; label: string; hint: string; onPress: () => void }) {
  return (
    <Tappable
      onPress={onPress}
      android_ripple={{ color: c.ripple, borderless: true }}
      accessibilityRole="button"
      accessibilityLabel={hint}
      style={({ pressed }) => [styles.step, { borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.stepText, { color: c.text }]}>{label}</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: 16, paddingTop: 14, gap: 2 },
  title: { fontFamily: FONTS.title, fontSize: 19, paddingHorizontal: 8 },
  excerpt: { fontFamily: FONTS.body, fontSize: 13.5, paddingHorizontal: 8, paddingBottom: 6 },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, paddingHorizontal: 8 },
  rowText: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 15.5 },
  hint: { fontFamily: FONTS.body, fontSize: 14 },
  picker: { gap: 8, paddingHorizontal: 8, paddingTop: 4 },
  label: { fontFamily: FONTS.bodySemi, fontSize: 13 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontFamily: FONTS.bodyBold, fontSize: 18, lineHeight: 22 },
  dayText: { flex: 1, textAlign: 'center', fontFamily: FONTS.bodySemi, fontSize: 14.5 },
  field: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, width: 110 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: { alignItems: 'center', borderRadius: 14, paddingVertical: 13, marginTop: 4 },
  buttonText: { fontFamily: FONTS.bodyBold, fontSize: 15.5 },
});
