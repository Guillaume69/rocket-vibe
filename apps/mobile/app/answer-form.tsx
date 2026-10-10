/**
 * Answering a workflow's form (RocketVibe, RFC 0004), a native sheet
 * (`presentation: 'formSheet'`, declared in `app/_layout.tsx`, closed by a tap
 * outside like Back, sending nothing). Opened from the form card of
 * `ui/messageRow.tsx` with the message id; the form is read from the stored
 * message (`messages.form`). One field per row: a text input (one line, or
 * several for a long text, a numeric keyboard for a number), a list of
 * options for a choice, a list of people for a person (the field's own, or the
 * room's members who are not bots, searchable). Submit checks what the server would refuse first,
 * then `POST /api/v1/forms/{message}/answer`; the answered message comes back
 * through sync.
 */
import { eq } from 'drizzle-orm';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { messages } from '../db/schema.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { FormField, User, WorkflowForm } from '../providers/rocketvibe/protocol.generated.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { useT } from '../ui/i18n.ts';
import type { TranslationKey } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { Icon } from '../ui/icon.tsx';
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
  const [room, setRoom] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | readonly string[]>>({});
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
      .select({ form: messages.form, rid: messages.rid })
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1)
      .then(
        (rows) => {
          if (canceled) return;
          setRoom(rows[0]?.rid ?? null);
          setForm(parseForm(rows[0]?.form));
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

  const change = (field: string, value: string | readonly string[]) => {
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
              field.kind === 'person' ? (
                <PersonInput
                  key={field.id}
                  c={c}
                  field={field}
                  named={form.people ?? []}
                  chat={chat}
                  room={room}
                  value={values[field.id] ?? ''}
                  disabled={busy}
                  onChange={(value) => change(field.id, value)}
                />
              ) : field.kind === 'choice' && field.multiple === true ? (
                <ChoicesInput key={field.id} c={c} field={field} value={values[field.id] ?? []} disabled={busy} onChange={(value) => change(field.id, value)} />
              ) : (
                <FieldInput key={field.id} c={c} field={field} value={single(values[field.id])} disabled={busy} onChange={(value) => change(field.id, value)} />
              )
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

/** The one value of a single-answer field. */
function single(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The ticked values: a value toggled in or out, in the order given. */
function toggled(value: string | readonly string[], item: string): string[] {
  const list = typeof value === 'string' ? [] : [...value];
  return list.includes(item) ? list.filter((v) => v !== item) : [...list, item];
}

/** A choice taking several answers: one checkbox per option. */
function ChoicesInput({ c, field, value, disabled, onChange }: { c: Colors; field: FormField; value: string | readonly string[]; disabled: boolean; onChange: (value: string[]) => void }) {
  const t = useT();
  const label = `${field.label}${field.required === true ? ' *' : ''}`;
  const picked = typeof value === 'string' ? [] : value;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.secondaryText }]}>{label}</Text>
      <View accessibilityLabel={label}>
        {(field.options ?? []).map((option) => (
          <CheckRow key={option} c={c} label={option} on={picked.includes(option)} disabled={disabled} onPress={() => onChange(toggled(value, option))} />
        ))}
      </View>
      {picked.length === 0 && <Text style={[styles.hint, { color: c.dimmed }]}>{t('forms.chooseSeveral')}</Text>}
    </View>
  );
}

function CheckRow({ c, label, on, disabled, onPress, children }: { c: Colors; label?: string; on: boolean; disabled: boolean; onPress: () => void; children?: React.ReactNode }) {
  return (
    <Tappable disabled={disabled} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} onPress={onPress} style={styles.option}>
      <Icon name={on ? 'checkbox-checked' : 'checkbox'} size={18} color={on ? c.accent : c.dimmed} style={styles.check} />
      {children ?? <Text style={[styles.text, styles.grow, { color: c.text }]}>{label}</Text>}
    </Tappable>
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
                <Icon name={on ? 'radio-checked' : 'radio'} size={18} color={on ? c.accent : c.dimmed} style={styles.check} />
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

/** Pages of room members read at most: a form names someone among the first thousands. */
const MEMBER_PAGES = 20;

/**
 * A person: one of the field's people, or any member of the room who is not a
 * bot (read here, page by page). A search narrows a long list; the value is a
 * user id.
 */
function PersonInput({ c, field, named, chat, room, value, disabled, onChange }: {
  c: Colors;
  field: FormField;
  named: readonly User[];
  chat: NativeChat | null;
  room: string | null;
  value: string | readonly string[];
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const t = useT();
  const label = `${field.label}${field.required === true ? ' *' : ''}`;
  const fixed = field.people ?? [];
  const several = field.multiple === true;
  const picked = typeof value === 'string' ? (value === '' ? [] : [value]) : value;
  const [members, setMembers] = useState<User[] | null | undefined>(fixed.length > 0 ? null : undefined);
  const [search, setSearch] = useState('');
  // Bumped by "Retry" after the members could not be read.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (fixed.length > 0 || chat === null || room === null) return;
    let canceled = false;
    void (async () => {
      const found: User[] = [];
      let after: string | undefined;
      let revision: string | undefined;
      for (let page = 0; page < MEMBER_PAGES; page++) {
        const current = await chat.roomMembers(room, after, revision);
        found.push(...current.members.filter((m) => !m.disabled && m.user.bot !== true && m.user.deleted !== true).map((m) => m.user));
        if (current.next == null) break;
        after = current.next;
        revision = current.revision;
      }
      return found.sort((a, b) => a.username.localeCompare(b.username));
    })().then(
      (found) => {
        if (!canceled) setMembers(found);
      },
      () => {
        if (!canceled) setMembers(null);
      },
    );
    return () => {
      canceled = true;
    };
    // `fixed` is the field's, stable for the sheet's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, room, attempt]);
  const candidates = fixed.length > 0 ? fixed.flatMap((id) => named.filter((u) => u.id === id)) : (members ?? []);
  const query = search.trim().toLowerCase();
  const shown = (query === '' ? candidates : candidates.filter((u) => u.username.toLowerCase().includes(query) || u.display_name.toLowerCase().includes(query))).slice(0, 50);
  // The picked ones stay in sight while the search moves on.
  const kept = candidates.filter((u) => picked.includes(u.id) && !shown.includes(u));
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.secondaryText }]}>{label}</Text>
      {fixed.length === 0 && members === undefined && <ActivityIndicator color={c.accent} />}
      {fixed.length === 0 && members === null && (
        <>
          <Text accessibilityRole="alert" style={[styles.hint, { color: c.errorText }]}>
            {t('forms.membersFailed')}
          </Text>
          <Tappable disabled={disabled} accessibilityRole="button" onPress={() => {
              setMembers(undefined);
              setAttempt((n) => n + 1);
            }} style={styles.option}>
            <Text style={[styles.retry, { color: c.accent }]}>{t('common.retry')}</Text>
          </Tappable>
        </>
      )}
      {candidates.length > 8 && (
        <TextInput
          style={[styles.input, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          value={search}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('forms.searchPerson')}
          placeholderTextColor={c.tertiaryText}
          accessibilityLabel={t('forms.searchPerson')}
          onChangeText={setSearch}
        />
      )}
      <View accessibilityRole={several ? undefined : 'radiogroup'} accessibilityLabel={label}>
        {[...kept, ...shown].map((u) => {
          const on = picked.includes(u.id);
          return several ? (
            <CheckRow key={u.id} c={c} on={on} disabled={disabled} onPress={() => onChange(toggled(value, u.id))}>
              <PersonName c={c} user={u} />
            </CheckRow>
          ) : (
            <PersonRow key={u.id} c={c} user={u} on={on} disabled={disabled} onPress={() => onChange(on && field.required !== true ? '' : u.id)} />
          );
        })}
      </View>
      {query !== '' && shown.length === 0 && <Text style={[styles.hint, { color: c.dimmed }]}>{t('forms.noPerson')}</Text>}
      {picked.length === 0 && candidates.length > 0 && <Text style={[styles.hint, { color: c.dimmed }]}>{t(several ? 'forms.chooseSeveral' : 'forms.choosePerson')}</Text>}
    </View>
  );
}

function PersonRow({ c, user, on, disabled, onPress }: { c: Colors; user: User; on: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Tappable disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: on, disabled }} onPress={onPress} style={styles.option}>
      <Icon name={on ? 'radio-checked' : 'radio'} size={18} color={on ? c.accent : c.dimmed} style={styles.check} />
      <PersonName c={c} user={user} />
    </Tappable>
  );
}

function PersonName({ c, user }: { c: Colors; user: User }) {
  return (
    <Text style={[styles.text, styles.grow, { color: c.text }]} numberOfLines={1}>
      {user.display_name || user.username} <Text style={{ color: c.dimmed }}>@{user.username}</Text>
    </Text>
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
  check: { width: 22, textAlign: 'center' },
  button: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 13, borderRadius: 14 },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  retry: { fontFamily: FONTS.bodyStrong, fontSize: 14 },
});
