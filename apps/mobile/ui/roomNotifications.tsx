import { eq } from 'drizzle-orm';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { subscriptions } from '../db/schema.ts';
import type { RoomNotificationLevel } from '../lib/normalize.ts';
import type { ProviderActions } from '../lib/provider.ts';
import { useT } from './i18n.ts';
import { useCoalescedLiveQuery } from './liveQuery.ts';
import type { TranslationKey } from './messages.ts';
import { Tappable } from './tappable.tsx';
import { FONTS, type Colors } from './theme.ts';

type Choice = RoomNotificationLevel | 'default';

const CHOICES: readonly { value: Choice; label: TranslationKey }[] = [
  { value: 'default', label: 'roomNotifications.default' },
  { value: 'all', label: 'roomNotifications.all' },
  { value: 'mentions', label: 'roomNotifications.mentions' },
  { value: 'nothing', label: 'roomNotifications.nothing' },
];

/**
 * The room's own notification choice (Rocket.Chat `rooms.saveNotification`,
 * desktop and push together), shown from the push choice the subscription
 * carries. Server first, then the local row, like the favourite; the
 * rebroadcast subscription confirms it.
 */
export function RoomNotificationChoice({
  c,
  rid,
  base,
  actions,
  current,
}: {
  c: Colors;
  rid: string;
  base: LocalDatabase;
  actions: ProviderActions;
  current: string | null;
}) {
  const t = useT();
  const [saving, setSaving] = useState<Choice | null>(null);
  const [failed, setFailed] = useState(false);
  const save = actions.roomNotifications?.bind(actions);
  if (save === undefined) return null;
  const selected: Choice =
    saving ?? (current === 'all' || current === 'mentions' || current === 'nothing' ? current : 'default');
  const choose = (value: Choice) => {
    if (saving !== null || value === selected) return;
    setSaving(value);
    setFailed(false);
    void save(rid, value)
      .then(() =>
        base
          .update(subscriptions)
          .set({ pushPreference: value === 'default' ? null : value })
          .where(eq(subscriptions.rid, rid)),
      )
      .catch(() => setFailed(true))
      .finally(() => setSaving(null));
  };
  return (
    <View style={styles.section}>
      <Text style={[styles.title, { color: c.dimmed }]}>{t('roomNotifications.title')}</Text>
      <View style={styles.choices} accessibilityRole="radiogroup">
        {CHOICES.map(({ value, label }) => {
          const active = value === selected;
          return (
            <Tappable
              key={value}
              onPress={() => choose(value)}
              disabled={saving !== null}
              accessibilityRole="radio"
              accessibilityState={{ checked: active, busy: saving === value }}
              android_ripple={{ color: c.ripple, borderless: false }}
              style={[
                styles.choice,
                {
                  borderColor: active ? c.accent : c.border,
                  backgroundColor: active ? c.surfaceActive : 'transparent',
                },
              ]}
            >
              <Text style={[styles.choiceText, { color: active ? c.text : c.dimmed }]}>{t(label)}</Text>
            </Tappable>
          );
        })}
      </View>
      {failed && <Text style={[styles.error, { color: c.errorText }]}>{t('roomNotifications.failed')}</Text>}
    </View>
  );
}

/**
 * The same choice for a room known only by its id: a direct message, whose
 * header opens the other person's profile rather than the room's information
 * (`app/profile.tsx`, the `dm` parameter). Nothing until the subscription is local.
 */
export function RoomNotificationChoiceFor({
  c,
  rid,
  base,
  actions,
}: {
  c: Colors;
  rid: string;
  base: LocalDatabase;
  actions: ProviderActions;
}) {
  const { data } = useCoalescedLiveQuery(base.select().from(subscriptions).where(eq(subscriptions.rid, rid)), [rid]);
  const subscription = data?.[0];
  if (subscription === undefined) return null;
  return <RoomNotificationChoice c={c} rid={rid} base={base} actions={actions} current={subscription.pushPreference} />;
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  title: { fontFamily: FONTS.bodyStrong, fontSize: 12, textTransform: 'uppercase' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, overflow: 'hidden' },
  choiceText: { fontFamily: FONTS.bodySemi, fontSize: 13.5 },
  error: { fontFamily: FONTS.body, fontSize: 13, fontStyle: 'italic' },
});
