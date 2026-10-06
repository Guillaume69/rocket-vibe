/**
 * New room sheet (RocketVibe server), `presentation: 'formSheet'` (declared in
 * `app/_layout.tsx`): a name, private or public, and, when the server offers
 * voice, a voice channel. The idempotent creation lives in NativeChat.
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useT } from '../ui/i18n.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

export default function NewRoomScreen() {
  const bottomMargin = useSheetBottomMargin();
  const sync = useSync();
  const c = useColors();
  const router = useRouter();
  const t = useT();
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat ?? null : null;
  const voiceOffered = sync.phase === 'ready' && sync.capabilities.voice === true;

  const [name, setName] = useState('');
  const [privateRoom, setPrivateRoom] = useState(true);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (chat === null || busy || name.trim() === '') return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const rid = await chat.createRoom(name, privateRoom, voice && voiceOffered);
        router.back();
        if (!voice) router.push({ pathname: '/room/[rid]', params: { rid } });
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        setError(t(code === 'permission_denied' ? 'newRoom.forbidden' : 'newRoom.failed'));
        setBusy(false);
      }
    })();
  };

  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void, hint: string) => (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, { color: c.text }]}>{label}</Text>
        <Text style={[styles.toggleHint, { color: c.dimmed }]}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} disabled={busy} trackColor={{ true: c.accent }} accessibilityLabel={label} />
    </View>
  );

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]}>{t('newRoom.title')}</Text>
      <TextInput
        style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
        placeholder={t('newRoom.name')}
        placeholderTextColor={c.dimmed}
        autoFocus
        maxLength={128}
        value={name}
        onChangeText={v => { setName(v); if (error !== null) setError(null); }}
        onSubmitEditing={submit}
        editable={!busy}
      />
      {toggle(t('newRoom.private'), privateRoom, setPrivateRoom, t(privateRoom ? 'newRoom.privateHint' : 'newRoom.publicHint'))}
      {voiceOffered && toggle(t('voice.channel'), voice, setVoice, t('newRoom.voiceHint'))}
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>}
      <Tappable
        onPress={submit}
        disabled={busy || name.trim() === '' || chat === null}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[styles.button, { backgroundColor: c.accent }, (busy || name.trim() === '') && styles.inactive]}
        accessibilityRole="button"
        accessibilityLabel={t('newRoom.create')}
      >
        {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.buttonText}>{t('newRoom.create')}</Text>}
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  field: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  toggleHint: { fontFamily: FONTS.body, fontSize: 12.5 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 13, borderRadius: 14 },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15, color: '#FFFFFF' },
});
