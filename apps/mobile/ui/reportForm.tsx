/**
 * The reason of a report, typed in the sheet it was asked from (message
 * actions, a profile), like the edit swap of the message sheet: a required
 * text of at most 1,000 characters (`lib/admin.ts#reportReason`), Cancel and
 * Report. The caller sends it and decides what follows (toast, close).
 */

import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { REPORT_REASON_MAX, reportReason } from '../lib/admin.ts';
import { useAdminError } from './adminKit.tsx';
import { useT } from './i18n.ts';
import type { TranslationKey } from './messages.ts';
import { type Colors, FONTS } from './theme.ts';

export function ReportForm({
  c,
  title,
  onCancel,
  onSend,
}: {
  c: Colors;
  title: string;
  onCancel: () => void;
  /** Resolves once the server took the report; a rejection shows under the field. */
  onSend: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const describe = useAdminError();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  // A double tap must not file the report twice.
  const inFlight = useRef(false);
  const reason = reportReason(text);

  const send = async () => {
    if (reason === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSend(reason);
    } catch (e) {
      setError(describe(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        maxLength={REPORT_REASON_MAX}
        placeholder={t('report.reason')}
        placeholderTextColor={c.tertiaryText}
        editable={!busy}
        style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
      />
      <Text style={[styles.counter, { color: c.tertiaryText }]}>
        {text.length} / {REPORT_REASON_MAX}
      </Text>
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(error)}</Text>}
      <View style={styles.row}>
        <Pressable disabled={busy} onPress={onCancel} style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[styles.secondaryText, { color: c.dimmed }]}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          disabled={busy || reason === null}
          onPress={() => void send()}
          accessibilityState={{ disabled: busy || reason === null }}
          style={({ pressed }) => [styles.primary, { backgroundColor: c.errorCard, opacity: pressed || busy || reason === null ? 0.6 : 1 }]}
        >
          <Text style={[styles.primaryText, { color: c.errorText }]}>{t('report.send')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  title: { fontFamily: FONTS.title, fontSize: 16 },
  field: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    fontFamily: FONTS.body,
    fontSize: 15,
    minHeight: 80,
    maxHeight: 200,
    textAlignVertical: 'top',
  },
  counter: { fontFamily: FONTS.body, fontSize: 11.5, textAlign: 'right' },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  secondary: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  secondaryText: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  primary: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  primaryText: { fontFamily: FONTS.title, fontSize: 15 },
});
