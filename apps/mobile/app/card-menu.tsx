/**
 * Picking in an integration card's menu (Mattermost and kChat), a native sheet
 * (`presentation: 'formSheet'`, declared in `app/_layout.tsx`, closed by a tap
 * outside like Back, picking nothing). The menu comes from
 * `ui/cardMenuStore.ts`: its listed choices filtered on the device, or people
 * or channels the server searches as I type (`ProviderActions.cardMenuOptions`).
 */
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { filterMenuOptions, type MenuOption } from '../lib/integrationCards.ts';
import { answerCardMenu, pendingCardMenu } from '../ui/cardMenuStore.ts';
import { useT } from '../ui/i18n.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';

export default function CardMenuScreen() {
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const sync = useSync();
  const bottomMargin = useSheetBottomMargin();
  const [request] = useState(pendingCardMenu);
  const [term, setTerm] = useState('');
  // The server's last answer and the text it answers; `options` is `null` when it failed.
  const [answer, setAnswer] = useState<{ term: string; options: MenuOption[] | null } | null>(null);
  const search = sync.phase === 'ready' ? sync.actions.cardMenuOptions?.bind(sync.actions) : undefined;
  const source = request?.menu.source ?? 'options';

  useEffect(() => () => {
    if (request !== null) answerCardMenu(request, null);
  }, [request]);

  useEffect(() => {
    if (request === null || source === 'options' || search === undefined) return;
    let canceled = false;
    const timer = setTimeout(() => {
      search(request.rid, source, term).then(
        (options) => {
          if (!canceled) setAnswer({ term, options });
        },
        () => {
          if (!canceled) setAnswer({ term, options: null });
        },
      );
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [request, search, source, term]);

  const found = search === undefined ? null : answer?.term === term ? answer.options : undefined;
  const shown = request === null ? [] : source === 'options' ? filterMenuOptions(request.menu.options, term) : (found ?? []);
  const choose = (option: MenuOption) => {
    if (request !== null) answerCardMenu(request, option);
    router.back();
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.deepCard }}
      contentContainerStyle={[styles.sheet, { paddingBottom: bottomMargin + 20 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ headerShown: false }} />
      {request !== null && <Text style={[styles.title, { color: c.text }]}>{request.title}</Text>}
      <TextInput
        value={term}
        onChangeText={setTerm}
        placeholder={t('card.menuSearch')}
        placeholderTextColor={c.dimmed}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel={t('card.menuSearch')}
        style={[styles.input, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
      />
      {source !== 'options' && found === undefined && <ActivityIndicator color={c.accent} />}
      {source !== 'options' && found === null && (
        <Text accessibilityRole="alert" style={[styles.text, { color: c.errorText }]}>
          {t('card.menuFailed')}
        </Text>
      )}
      {shown.length === 0 && (source === 'options' || Array.isArray(found)) && (
        <Text style={[styles.text, { color: c.dimmed }]}>{t('card.menuEmpty')}</Text>
      )}
      {shown.map((option) => (
        <Tappable
          key={option.value}
          onPress={() => choose(option)}
          android_ripple={{ color: c.ripple }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          style={styles.option}
          accessibilityRole="button"
          accessibilityLabel={option.label}
        >
          <Text style={[styles.text, { color: c.text }]} numberOfLines={2}>
            {option.label}
          </Text>
        </Tappable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 10 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  text: { fontFamily: FONTS.body, fontSize: 15, lineHeight: 21 },
  input: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  option: { paddingVertical: 12, paddingHorizontal: 4 },
});
