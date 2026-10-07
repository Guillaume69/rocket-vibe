/**
 * Someone of a voice session, for this side only (native sheet, opened by a
 * long press on them): how loud they play here, 0 to 200 %, and a mute that
 * only this device hears. Kept between runs.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { useT } from '../../ui/i18n.ts';
import { useSheetBottomMargin } from '../../ui/sheetMargin.ts';
import { Slider } from '../../ui/slider.tsx';
import { FONTS, useColors } from '../../ui/theme.ts';
import { useListening, useVoiceController } from '../../ui/voice.tsx';

export default function VoicePerson() {
  const { uid, name } = useLocalSearchParams<{ uid: string; name?: string }>();
  const c = useColors();
  const t = useT();
  const bottomMargin = useSheetBottomMargin();
  const controller = useVoiceController();
  const listening = useListening();
  if (!controller) return null;
  const person = listening.people[uid] ?? { volume: 1, muted: false };
  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin + 20 }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{name ?? ''}</Text>
      <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.personVolume')}</Text>
      <Slider c={c} label={t('voice.personVolume')} value={person.volume} format={v => `${Math.round(v * 100)} %`}
        onChange={v => void controller.setPersonVolume(uid, v, person.muted)} />
      <View style={styles.toggle}>
        <View style={styles.toggleText}>
          <Text style={[styles.toggleLabel, { color: c.text }]}>{t('voice.muteForMe')}</Text>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('voice.muteForMeHint')}</Text>
        </View>
        <Switch value={person.muted} trackColor={{ true: c.accent }} accessibilityLabel={t('voice.muteForMe')}
          onValueChange={muted => void controller.setPersonVolume(uid, person.volume, muted)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, gap: 12 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  heading: { fontFamily: FONTS.bodyStrong, fontSize: 12, letterSpacing: 0.4 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
