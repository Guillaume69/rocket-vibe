/**
 * E2EE unlock sheet, `presentation: 'formSheet'` (declared in
 * `app/_layout.tsx`). Opened lazily on tapping a locked encrypted room, or
 * from the settings. Asks for the E2E password, unlocks the private key (once
 * for the device), then decrypts the messages already in the database; the
 * UI (live query) refreshes on its own.
 */

import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { E2EError } from '../lib/e2e/crypto.ts';
import { useT } from '../ui/i18n.ts';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';

export default function UnlockE2EScreen() {
  const bottomMargin = useSheetBottomMargin();
  const sync = useSync();
  const c = useColors();
  const router = useRouter();
  const t = useT();

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  const unlock =
    sync.phase === 'ready' ? sync.unlockE2E : null;

  const submit = (): void => {
    if (unlock === null || busy || password === '') return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await unlock(password);
        // Success: the sheet closes, the messages light up. Unless it was
        // closed meanwhile (an outside tap): a second back would leave the room.
        if (open.current) router.back();
      } catch (e) {
        // A wrong password fails GCM authentication (E2EError);
        // everything else (network, missing key) is generic.
        setError(t(e instanceof E2EError ? 'e2e.wrongPassword' : 'e2e.genericError'));
        setBusy(false);
      }
    })();
  };

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]}>{t('e2e.title')}</Text>
      <Text style={[styles.explanation, { color: c.dimmed }]}>{t('e2e.explanation')}</Text>

      <TextInput
        style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
        placeholder={t('e2e.field')}
        placeholderTextColor={c.dimmed}
        secureTextEntry
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        // Engages the autofill framework (Bitwarden, etc.): without a hint, a lone
        // `secureTextEntry` field offers no autofill on Android.
        autoComplete="password"
        textContentType="password"
        importantForAutofill="yes"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          if (error !== null) setError(null);
        }}
        onSubmitEditing={submit}
        editable={!busy}
      />

      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>}

      <Tappable
        onPress={submit}
        disabled={busy || password === '' || unlock === null}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[
          styles.button,
          { backgroundColor: c.accent },
          (busy || password === '') && styles.inactive,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('e2e.unlock')}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>{t('e2e.unlock')}</Text>
        )}
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  explanation: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  field: {
    fontFamily: FONTS.body,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 13,
    borderRadius: 14,
  },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15, color: '#FFFFFF' },
});
