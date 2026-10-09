/**
 * The shared bricks of the administration screens (`app/admin/`): the error
 * sentence of a failed call, the paged and searchable list state, and a few
 * visual pieces built on theme tokens and RN primitives only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AdminRefused, LastOwnerError, type AdminPage, type ProviderAdmin } from '../lib/admin.ts';
import { dismissible } from './alerts.ts';
import { useAdminVerdict } from './adminAccess.ts';
import type { ProviderError } from '../lib/provider.ts';
import { useLanguage, useT } from './i18n.ts';
import { notify } from './toast.tsx';
import type { TranslationKey } from './messages.ts';
import { useSync } from './sync.tsx';
import { Tappable } from './tappable.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY } from './theme.ts';

/** The sentence for a failed administration call, from both servers' errors. */
export function adminErrorKey(e: ProviderError): TranslationKey {
  switch (e.code) {
    case 'self_administration':
      return 'admin.errSelf';
    case 'last_administrator':
    // Rocket.Chat refusing to remove the last admin role.
    case 'error-admin-required':
      return 'admin.errLastAdmin';
    case 'revision_conflict':
    case 'operation_conflict':
      return 'admin.errChanged';
    case 'self_report':
      return 'report.self';
    case 'message_deleted':
      return 'report.gone';
    // RocketVibe: a bot is never an administrator, nor active in an encrypted room.
    case 'bot_privilege':
      return 'admin.errBotPrivilege';
    case 'bot_encrypted_room':
      return 'admin.errBotEncryptedRoom';
    // Rocket.Chat refuses a missing permission with 400 `not_authorized` on some routes.
    case 'not_authorized':
      return 'admin.errDenied';
  }
  if (e.status === 0 || e.status >= 500 || e.code === 'offline') return 'admin.errOffline';
  if (e.status === 403 || e.code === 'permission_denied' || e.code === 'error-action-not-allowed') return 'admin.errDenied';
  if (e.status === 404 || e.code === 'not_found') return 'admin.errNotFound';
  return 'admin.failed';
}

/** `describeError` of the current provider, as a translation key. */
export function useAdminError(): (error: unknown) => TranslationKey {
  const sync = useSync();
  const provider = sync.phase === 'ready' ? sync.provider : null;
  return useCallback(
    (error: unknown) =>
      error instanceof AdminRefused
        ? error.key
        : provider === null
          ? 'admin.failed'
          : adminErrorKey(provider.describeError(error, true)),
    [provider],
  );
}

/**
 * A paged list read from the server: the first page on mount and on each new
 * `load` (a new search), `more` at the end of the list, `refresh` from the
 * top. A new search or refresh empties the list when it STARTS (rows belong
 * to the read that produced them), so a failed first page never shows the
 * previous query's rows; an answer for an older read is dropped.
 */
export function useAdminPages<T>(load: ((after: string | null) => Promise<AdminPage<T>>) | null) {
  const describe = useAdminError();
  // Bumped by a pull; with `load`, names the read whose rows are shown.
  const [reads, setReads] = useState(0);
  const current = useMemo(() => ({ load, reads }), [load, reads]);
  const [result, setResult] = useState<{ read: typeof current; items: T[]; next: string | null; error: TranslationKey | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  }, [current]);

  useEffect(() => {
    if (current.load === null) return;
    let alive = true;
    current.load(null).then(
      (page) => {
        if (alive) setResult({ read: current, items: page.items, next: page.next, error: null });
      },
      (e: unknown) => {
        if (alive) setResult({ read: current, items: [], next: null, error: describe(e) });
      },
    ).finally(() => {
      if (alive) setRefreshing(false);
    });
    return () => {
      alive = false;
    };
  }, [current, describe]);

  const mine = result !== null && result.read === current ? result : null;
  const more = useCallback(() => {
    if (mine === null || mine.next === null || load === null || moreBusy) return;
    const asked = current;
    setMoreBusy(true);
    load(mine.next).then(
      (page) => {
        if (latest.current !== asked) return;
        setResult((old) => (old === null || old.read !== asked ? old : { ...old, items: [...old.items, ...page.items], next: page.next }));
      },
      (e: unknown) => {
        if (latest.current !== asked) return;
        setResult((old) => (old === null || old.read !== asked ? old : { ...old, error: describe(e) }));
      },
    ).finally(() => setMoreBusy(false));
  }, [mine, load, moreBusy, current, describe]);

  const setItems = useCallback((change: (items: T[]) => T[]) => {
    setResult((old) => (old === null ? old : { ...old, items: change(old.items) }));
  }, []);

  return {
    items: mine?.items ?? NO_ITEMS as T[],
    setItems,
    loading: (mine === null && !refreshing) || moreBusy,
    refreshing,
    error: mine?.error ?? null,
    refresh: useCallback(() => {
      setRefreshing(true);
      setReads((n) => n + 1);
    }, []),
    more,
  };
}
const NO_ITEMS: never[] = [];

/**
 * One administration action at a time (a double tap must not send it twice),
 * its outcome as a toast or an error key for the opened item.
 */
export function useAdminRun() {
  const t = useT();
  const describe = useAdminError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const inFlight = useRef(false);
  const run = useCallback(
    async (action: () => Promise<void>, done: TranslationKey | null) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
        if (done !== null) notify(t(done));
      } catch (e) {
        setError(describe(e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [describe, t],
  );
  return { busy, error, setError, run };
}

/**
 * A confirmation in a native dialog: Cancel, an outside tap or Back do
 * nothing; only `action` runs `onConfirm` (destructive style).
 */
export function confirmAction(title: string, body: string, action: string, cancel: string, onConfirm: () => void): void {
  Alert.alert(title, body, [
    { text: cancel, style: 'cancel' },
    { text: action, style: 'destructive', onPress: onConfirm },
  ], dismissible());
}

/**
 * Rocket.Chat's second confirmation of a deactivation or deletion that
 * would leave rooms without owner (`LastOwnerError`): which rooms go with
 * the account, which change owner; agreed, `retry` runs with `relinquish`.
 * Any other error is rethrown.
 */
export function useLastOwnerConfirm() {
  const t = useT();
  return useCallback(
    async (action: (relinquish: boolean) => Promise<void>): Promise<boolean> => {
      try {
        await action(false);
        return true;
      } catch (e) {
        if (!(e instanceof LastOwnerError)) throw e;
        const agreed = await new Promise<boolean>((resolve) => {
          const lines = [
            e.removed.length > 0 ? t('admin.lastOwnerRemoved', { rooms: e.removed.join(', ') }) : null,
            e.reassigned.length > 0 ? t('admin.lastOwnerReassigned', { rooms: e.reassigned.join(', ') }) : null,
          ].filter((l) => l !== null);
          Alert.alert(t('admin.lastOwnerTitle'), lines.join('\n\n'), [
            { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('admin.lastOwnerConfirm'), style: 'destructive', onPress: () => resolve(true) },
          ], dismissible(() => resolve(false)));
        });
        if (!agreed) return false;
        await action(true);
        return true;
      }
    },
    [t],
  );
}

/** Dates and numbers of the admin screens in the APP's language, not the phone's. */
export function useAdminFormat() {
  const language = useLanguage();
  return useMemo(() => {
    const locale = language === 'fr' ? 'fr-FR' : 'en-US';
    const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    const moment = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const number = new Intl.NumberFormat(locale);
    return {
      /** A date, or a dash when the server does not know it. */
      date: (ms: number | null) => (ms === null ? '—' : day.format(new Date(ms))),
      dateTime: (ms: number) => moment.format(new Date(ms)),
      /** A count, or a dash when it could not be read. */
      number: (n: number | null) => (n === null ? '—' : number.format(n)),
    };
  }, [language]);
}

/** A search text, applied 300 ms after the last keystroke. */
export function useDebounced(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function SearchField({ c, value, onChange, placeholder }: { c: Colors; value: string; onChange: (v: string) => void; placeholder: string }) {
  const t = useT();
  return (
    <View style={[styles.search, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Text style={styles.magnifier}>🔍</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.tertiaryText}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.searchField, { color: c.text }]}
      />
      {value !== '' && (
        <Pressable onPress={() => onChange('')} hitSlop={8} accessibilityLabel={t('emojiPicker.clearSearch')}>
          <Text style={{ color: c.tertiaryText }}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A titled card of the dashboard. */
export function AdminCard({ c, title, children }: { c: Colors; title: string; children: ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Text style={[styles.cardTitle, { color: c.dimmed }]}>{title}</Text>
      {children}
    </View>
  );
}

/** A label and its value on one line; an optional dot before the label. */
export function StatLine({ c, label, value, dot, strong = false }: { c: Colors; label: string; value: string; dot?: string; strong?: boolean }) {
  return (
    <View style={styles.stat}>
      {dot !== undefined && <View style={[styles.dot, { backgroundColor: dot }]} />}
      <Text style={[styles.statLabel, { color: c.secondaryText }]}>{label}</Text>
      <Text style={[strong ? styles.statStrong : styles.statValue, { color: c.text }]} selectable numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function Badge({ c, label, tone = 'plain' }: { c: Colors; label: string; tone?: 'plain' | 'accent' | 'danger' }) {
  const color = tone === 'accent' ? c.accent : tone === 'danger' ? c.errorText : c.dimmed;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/** A text action of an opened item; `danger` for destructive ones. */
export function ItemAction({ c, label, onPress, disabled, danger = false }: { c: Colors; label: string; onPress: () => void; disabled: boolean; danger?: boolean }) {
  return (
    <Tappable
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: c.ripple }}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      style={({ pressed }) => [styles.action, { backgroundColor: danger ? c.errorCard : c.surfaceActive, opacity: pressed || disabled ? 0.6 : 1 }]}
    >
      <Text style={[styles.actionText, { color: danger ? c.errorText : c.text }]}>{label}</Text>
    </Tappable>
  );
}

/** Under a list: a spinner while a page loads, the error, or nothing. */
export function ListFooter({ c, loading, error }: { c: Colors; loading: boolean; error: TranslationKey | null }) {
  const t = useT();
  if (loading) return <ActivityIndicator color={c.accent} style={styles.footer} />;
  if (error !== null) return <Text style={[styles.footerText, { color: c.errorText }]}>{t(error)}</Text>;
  return null;
}

/**
 * The body of an administration screen once the account is known to
 * administer this server: a spinner while asking, a sentence when it does
 * not (or offline, or a server without administration).
 */
export function AdminGate({ c, children }: { c: Colors; children: (admin: ProviderAdmin) => ReactNode }) {
  const t = useT();
  const verdict = useAdminVerdict();
  if (verdict === 'unknown') return <ActivityIndicator color={c.accent} style={styles.footer} />;
  if (verdict === 'no') return <Text style={[styles.footerText, { color: c.dimmed }]}>{t('admin.unavailable')}</Text>;
  return <>{children(verdict)}</>;
}


export const adminStyles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  row: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowTexts: { flex: 1, gap: 2 },
  title: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  sub: { fontFamily: FONTS.body, fontSize: 12.5 },
  body: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 19 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  empty: { fontFamily: FONTS.body, fontSize: 14, textAlign: 'center', paddingVertical: 24 },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
});

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12 },
  magnifier: { fontSize: 14 },
  searchField: { flex: 1, fontFamily: FONTS.body, fontSize: 15, paddingVertical: 10 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
  cardTitle: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  statLabel: { flex: 1, fontFamily: FONTS.body, fontSize: 13.5 },
  statValue: { fontFamily: FONTS.bodyBold, fontSize: 13.5, flexShrink: 1, textAlign: 'right' },
  statStrong: { fontFamily: FONTS.title, fontSize: 17, flexShrink: 1, textAlign: 'right' },
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontFamily: FONTS.bodyStrong, fontSize: 11 },
  action: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  actionText: { fontFamily: FONTS.bodyBold, fontSize: 13.5 },
  footer: { paddingVertical: 16 },
  footerText: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center', paddingVertical: 12 },
});
