/**
 * Answering a workflow's form (RocketVibe, RFC 0004), a native sheet
 * (`presentation: 'formSheet'`, declared in `app/_layout.tsx`, closed by a tap
 * outside like Back, sending nothing). Opened from the form card of
 * `ui/messageRow.tsx` with the message id; the form is read from the stored
 * message (`messages.form`). One field per row: a text input (one line, or
 * several for a long text, a numeric keyboard for a number), a list of
 * options for a choice. Submit checks what the server would refuse first,
 * then `POST /api/v1/forms/{message}/answer`; the answered message comes back
 * through sync.
 */
import { eq } from 'drizzle-orm';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { messages } from '../db/schema.ts';
import type { FormField, WorkflowForm } from '../providers/rocketvibe/protocol.generated.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { useT } from '../ui/i18n.ts';
import type { TranslationKey } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, LIST_PRESS_DELAY, useColors, type Colors } from '../ui/theme.ts';
import { answerInput, formErrorKey, formState, parseForm } from '../ui/workflowsModel.ts';

export default function AnswerFormScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const bottomMargin = useSheetBottomMargin();
  const { state } = useSession();
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat ?? null : null;
  const base = sync.phase === 'ready' ? sync.base : null;
  const me = state.phase === 'connected' ? state.session.userId : null;
  // `undefined` while reading, `null` when there is no form to answer.
  const [form, setForm] = useState<WorkflowForm | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One answer intent per filled sheet: a retry after a lost answer replays
  // it, which the server takes as the same success.
  const operation = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    if (base === null || typeof id !== 'string') return;
    let canceled = false;
    void base
      .select({ form: messages.form })
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1)
      .then(
        (rows) => {
          if (!canceled) setForm(parseForm(rows[0]?.form));
        },
        () => {
          if (!canceled) setForm(null);
        },
      );
    return () => {
      canceled = true;
    };
  }, [base, id]);

  // The clock read once, when the sheet opens: a form expires in days.
  const [openedAt] = useState(() => Date.now());
  const open = form != null && formState(form, me, openedAt) === 'answer';

  const change = (field: string, value: string) => {
    operation.current = null;
    setError(null);
    setValues((v) => ({ ...v, [field]: value }));
  };

  const submit = () => {
    if (chat === null || form == null || busy || typeof id !== 'string') return;
    const checked = answerInput(form.fields, values);
    if (!('answers' in checked)) {
      const label = form.fields.find((f) => f.id === checked.field)?.label ?? checked.field;
      setError(t(checked.problem === 'required' ? 'forms.required' : 'forms.invalid', { label }));
      return;
    }
    operation.current ??= chat.operationId();
    const intent = operation.current;
    setBusy(true);
    setError(null);
    void chat.answerForm(id, checked.answers, intent).then(
      () => {
        if (alive.current) router.back();
      },
      (e: unknown) => {
        if (!alive.current) return;
        const key: TranslationKey = e instanceof NativeError ? formErrorKey(e.code, e.status) : 'forms.failed';
        setError(t(key));
        setBusy(false);
      },
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.deepCard }}
      contentContainerStyle={[styles.sheet, { paddingBottom: bottomMargin + 20 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ headerShown: false }} />
      {form === undefined && <ActivityIndicator color={c.accent} />}
      {form === null && <Text style={[styles.text, { color: c.dimmed }]}>{t('forms.unavailable')}</Text>}
      {form != null && (
        <>
          <Text style={[styles.title, { color: c.text }]}>{form.title}</Text>
          {!open && <Text style={[styles.text, { color: c.dimmed }]}>{t('forms.unavailable')}</Text>}
          {open &&
            form.fields.map((field) => (
              <FieldInput key={field.id} c={c} field={field} value={values[field.id] ?? ''} disabled={busy} onChange={(value) => change(field.id, value)} />
            ))}
          {error !== null && (
            <Text accessibilityRole="alert" style={[styles.text, { color: c.errorText }]}>
              {error}
            </Text>
          )}
          {open && (
            <Tappable
              onPress={submit}
              disabled={busy || chat === null}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={[styles.button, { backgroundColor: c.accent }, busy && styles.inactive]}
              accessibilityRole="button"
              accessibilityLabel={t('forms.submit')}
            >
              {busy ? <ActivityIndicator size="small" color={c.onAccent} /> : <Text style={[styles.buttonText, { color: c.onAccent }]}>{t('forms.submit')}</Text>}
            </Tappable>
          )}
        </>
      )}
    </ScrollView>
  );
}

function FieldInput({ c, field, value, disabled, onChange }: { c: Colors; field: FormField; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const t = useT();
  const label = `${field.label}${field.required === true ? ' *' : ''}`;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.secondaryText }]}>{label}</Text>
      {field.kind === 'choice' ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={label}>
          {(field.options ?? []).map((option) => {
            const on = value === option;
            return (
              <Tappable
                key={option}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, disabled }}
                onPress={() => onChange(on && field.required !== true ? '' : option)}
                style={styles.option}
              >
                <Text style={[styles.check, { color: on ? c.accent : c.dimmed }]}>{on ? '◉' : '○'}</Text>
                <Text style={[styles.text, styles.grow, { color: c.text }]}>{option}</Text>
              </Tappable>
            );
          })}
          {value === '' && <Text style={[styles.hint, { color: c.dimmed }]}>{t('forms.choose')}</Text>}
        </View>
      ) : (
        <TextInput
          style={[styles.input, field.kind === 'long_text' && styles.multiline, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          value={value}
          editable={!disabled}
          multiline={field.kind === 'long_text'}
          keyboardType={field.kind === 'number' ? 'numeric' : 'default'}
          maxLength={field.kind === 'long_text' ? 4096 : 1024}
          placeholderTextColor={c.tertiaryText}
          accessibilityLabel={label}
          onChangeText={onChange}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  field: { gap: 6 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 14 },
  text: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5 },
  grow: { flex: 1 },
  input: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  check: { fontSize: 18, width: 22, textAlign: 'center' },
  button: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 13, borderRadius: 14 },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
