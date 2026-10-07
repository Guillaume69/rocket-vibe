/**
 * The call's audio options, beside the microphone as in Discord (native
 * sheet, `presentation: 'formSheet'` in `app/_layout.tsx`): where the sound
 * goes (the microphone follows it), the microphone's volume and level, the
 * speakers' volume, the noise remover, deafen, and the screen share's quality.
 */
import { Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { VoiceRoute } from '../../modules/voice/index.ts';
import { useT } from '../../ui/i18n.ts';
import { useSheetBottomMargin } from '../../ui/sheetMargin.ts';
import { Slider } from '../../ui/slider.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';
import { useInputLevel, useListening, useVoice, useVoiceController } from '../../ui/voice.tsx';

const ROUTES: VoiceRoute[] = ['speaker', 'earpiece', 'wired', 'bluetooth'];
const QUALITIES: { height: number; fps: number; label: string }[] = [
  { height: 720, fps: 15, label: '720p · 15' },
  { height: 720, fps: 30, label: '720p · 30' },
  { height: 1080, fps: 15, label: '1080p · 15' },
  { height: 1080, fps: 30, label: '1080p · 30' },
  { height: 1440, fps: 60, label: '1440p · 60' },
];
const percent = (v: number): string => `${Math.round(v * 100)} %`;

export default function VoiceMenu() {
  const c = useColors();
  const t = useT();
  const bottomMargin = useSheetBottomMargin();
  const controller = useVoiceController();
  const voice = useVoice();
  const listening = useListening();
  const level = useInputLevel();
  if (!controller) return null;
  const routes = ROUTES.filter(r => voice.routes.includes(r));
  return (
    <ScrollView style={{ backgroundColor: c.deepCard }} contentContainerStyle={[styles.sheet, { paddingBottom: bottomMargin + 20 }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]}>{t('voice.menu')}</Text>
      {routes.length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.output')}</Text>
          <View style={styles.chips}>
            {routes.map(route => (
              <Chip key={route} c={c} label={t(`voice.route.${route}`)} selected={voice.route === route}
                onPress={() => void controller.setRoute(route)} />
            ))}
          </View>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('voice.outputHint')}</Text>
        </View>
      )}
      <View style={styles.block}>
        <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.inputVolume')}</Text>
        <Slider c={c} label={t('voice.inputVolume')} value={listening.inputVolume} format={percent}
          onChange={v => void controller.setInputVolume(v)} />
      </View>
      <View style={styles.block}>
        <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.inputLevel')}</Text>
        <Meter c={c} level={level} />
      </View>
      <View style={styles.block}>
        <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.outputVolume')}</Text>
        <Slider c={c} label={t('voice.outputVolume')} value={listening.outputVolume} format={percent}
          onChange={v => void controller.setOutputVolume(v)} />
      </View>
      <Toggle c={c} label={t('voice.noise')} hint={t('voice.noiseHint')} value={listening.noiseSuppression}
        onChange={on => void controller.setNoiseSuppression(on)} />
      <Toggle c={c} label={t('voice.deafenSwitch')} value={voice.deafened} onChange={on => void controller.setDeafened(on)} />
      <View style={styles.block}>
        <Text style={[styles.heading, { color: c.dimmed }]}>{t('voice.shareQuality')}</Text>
        <View style={styles.chips}>
          {QUALITIES.map(q => (
            <Chip key={q.label} c={c} label={q.label}
              selected={listening.share.height === q.height && listening.share.fps === q.fps}
              onPress={() => void controller.setShareQuality(q.height, q.fps)} />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function Chip({ c, label, selected, onPress }: { c: Colors; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} android_ripple={{ color: c.ripple }}
      style={[styles.chip, { backgroundColor: selected ? c.accent : c.card, borderColor: selected ? c.accent : c.border }]}>
      <Text style={[styles.chipText, { color: selected ? '#FFFFFF' : c.text }]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ c, label, hint, value, onChange }: { c: Colors; label: string; hint?: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, { color: c.text }]}>{label}</Text>
        {hint !== undefined && <Text style={[styles.hint, { color: c.dimmed }]}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: c.accent }} accessibilityLabel={label} />
    </View>
  );
}

/** The microphone's level as segments, as Discord's meter. */
function Meter({ c, level }: { c: Colors; level: number }) {
  const segments = 24;
  const lit = Math.round(level * segments);
  return (
    <View style={styles.meter} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}>
      {Array.from({ length: segments }, (_, i) => (
        <View key={i} style={[styles.segment, { backgroundColor: i < lit ? c.online : c.border }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, gap: 16 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  block: { gap: 8 },
  heading: { fontFamily: FONTS.bodyStrong, fontSize: 12, letterSpacing: 0.4 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  chipText: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  meter: { flexDirection: 'row', gap: 3, height: 14 },
  segment: { flex: 1, borderRadius: 2 },
});
