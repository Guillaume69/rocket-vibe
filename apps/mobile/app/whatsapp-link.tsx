import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WhatsApp } from '../modules/whatsapp/index.ts';
import { fallbackName, parseFrame } from '@rocket-vibe/provider-whatsapp/frames';
import { INITIAL_STATUS, nextStatus, type WaStatus } from '@rocket-vibe/provider-whatsapp/projection';
import { useT } from '../ui/i18n.ts';
import type { TranslationKey } from '../ui/messages.ts';
import { PillField, PrimaryButton } from '../ui/kit.tsx';
import { TextQrCode } from '../ui/qrCode.tsx';
import { useSession } from '../ui/session.tsx';
import { FONTS, useColors } from '../ui/theme.ts';

/** `ABCD1234` shown as WhatsApp shows it, `ABCD-1234`. */
const shown = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/**
 * Linking a WhatsApp account: a new engine state reaches WhatsApp, which
 * gives a code for the number typed here (the phone that runs WhatsApp is
 * usually this one, which cannot scan its own screen), or a QR for another
 * phone. Once WhatsApp names the account, it is saved and opened. Leaving
 * the sheet before that, by any way, stops the attempt and erases its state.
 */
export default function WhatsAppLink() {
  const t = useT();
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connect } = useSession();
  const [state] = useState(() => WhatsApp?.newState() ?? null);
  const [status, setStatus] = useState<WaStatus>(INITIAL_STATUS);
  const [number, setNumber] = useState('');
  const [asking, setAsking] = useState(false);
  const [qr, setQr] = useState(false);
  const [failed, setFailed] = useState<TranslationKey | null>(null);
  const linked = useRef(false);

  useEffect(() => {
    if (WhatsApp === null || state === null) return;
    const engine = WhatsApp;
    const subscription = engine.addListener('frame', (event) => {
      if (event.state !== state) return;
      const frame = parseFrame(event.frame);
      if (frame === null) return;
      setStatus((old) => nextStatus(old, frame) ?? old);
      if (frame.type === 'pairing_code' || frame.type === 'error') setAsking(false);
    });
    engine.start(state).catch(() => setFailed('wa.link.failed'));
    return () => {
      subscription.remove();
      // Abandoned: nothing of the half-made link stays on the phone.
      if (!linked.current) void engine.forget(state).catch(() => {});
    };
  }, [state]);

  useEffect(() => {
    if (state === null || linked.current || status.state !== 'connected' || status.account === null) return;
    linked.current = true;
    const jid = status.account.jid;
    // Shown as its WhatsApp name, else its number; the JID stays the account id.
    const username = status.account.name || fallbackName(jid);
    void connect({ baseUrl: `whatsapp://${state}`, authToken: '', userId: jid, username, kind: 'whatsapp', siteUrl: null })
      .then(() => router.replace('/'))
      .catch(() => { linked.current = false; setFailed('wa.link.failed'); });
  }, [state, status, connect, router]);

  const ask = () => {
    const digits = number.replace(/\D/g, '');
    if (WhatsApp === null || state === null || digits.length < 8) {
      setStatus((old) => ({ ...old, error: 'phone_invalid' }));
      return;
    }
    setAsking(true);
    setStatus((old) => ({ ...old, error: null }));
    WhatsApp.handle(state, JSON.stringify({ type: 'pair_phone', text: digits })).catch(() => setAsking(false));
  };

  const error: TranslationKey | null = failed
    ?? (status.error === 'phone_invalid' ? 'wa.link.phoneInvalid'
      : status.error === 'pairing_code_failed' ? 'wa.link.codeFailed'
        : status.state === 'error' ? 'wa.link.failed' : null);
  const connecting = status.account !== null && status.state !== 'connected';

  return (
    <ScrollView contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, { color: c.text }]}>{t('wa.link.title')}</Text>
      {WhatsApp === null ? (
        <Text style={[styles.help, { color: c.dimmed }]}>{t('wa.link.unavailable')}</Text>
      ) : (
        <>
          <Text style={[styles.help, { color: c.text }]}>{t('wa.link.intro')}</Text>
          <Text style={[styles.help, { color: c.dimmed }]}>{t('wa.link.warning')}</Text>
          {connecting || (status.qr === null && status.pairingCode === null && status.state !== 'error' && !failed) ? (
            <View style={styles.waiting}>
              <ActivityIndicator color={c.accent} />
              <Text style={[styles.help, { color: c.dimmed }]}>{t(connecting ? 'wa.link.linking' : 'wa.link.waiting')}</Text>
            </View>
          ) : status.pairingCode !== null ? (
            <View style={styles.block}>
              <Text style={[styles.overline, { color: c.dimmed }]}>{t('wa.link.code')}</Text>
              <Text selectable accessibilityLabel={status.pairingCode.split('').join(' ')} style={[styles.code, { color: c.text }]}>
                {shown(status.pairingCode)}
              </Text>
              <Text style={[styles.help, { color: c.dimmed }]}>{t('wa.link.codeHelp')}</Text>
              <PrimaryButton c={c} title={t('wa.link.openWhatsApp')} onPress={() => void Linking.openURL('whatsapp://').catch(() => {})} />
              <Pressable onPress={() => void Clipboard.setStringAsync(status.pairingCode ?? '')} accessibilityRole="button">
                <Text style={[styles.link, { color: c.cyan }]}>{t('wa.link.copy')}</Text>
              </Pressable>
            </View>
          ) : qr && status.qr !== null ? (
            <View style={styles.block}>
              <TextQrCode text={status.qr} label={t('wa.link.qr')} />
              <Text style={[styles.help, { color: c.dimmed }]}>{t('wa.link.qrHelp')}</Text>
            </View>
          ) : (
            <View style={styles.block}>
              <PillField c={c} label={t('wa.link.number')} value={number} onChangeText={setNumber}
                onSubmitEditing={ask} keyboardType="phone-pad" autoComplete="tel" placeholder="+33 6 12 34 56 78" editable={!asking} />
              <Text style={[styles.help, { color: c.dimmed }]}>{t('wa.link.numberHelp')}</Text>
              <PrimaryButton c={c} busy={asking} title={t('wa.link.getCode')} onPress={ask} />
              {status.qr !== null && (
                <Pressable onPress={() => { setQr(true); setStatus((old) => ({ ...old, error: null })); }} accessibilityRole="button">
                  <Text style={[styles.link, { color: c.cyan }]}>{t('wa.link.otherPhone')}</Text>
                </Pressable>
              )}
            </View>
          )}
          {error !== null && <Text style={[styles.help, { color: c.danger }]} accessibilityLiveRegion="polite">{t(error)}</Text>}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 24, gap: 14 },
  title: { fontFamily: FONTS.titleStrong, fontSize: 22 },
  help: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  overline: { fontFamily: FONTS.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  block: { gap: 12 },
  waiting: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12 },
  code: { fontFamily: FONTS.titleStrong, fontSize: 36, letterSpacing: 4, textAlign: 'center' },
  link: { fontFamily: FONTS.bodyBold, fontSize: 14, textAlign: 'center', paddingVertical: 8 },
});
