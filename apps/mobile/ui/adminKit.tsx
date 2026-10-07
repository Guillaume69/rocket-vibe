/**
 * The shared bricks of the administration screens (`app/admin/`): the error
 * sentence of a failed call, the paged and searchable list state, and a few
 * visual pieces built on theme tokens and RN primitives only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { AdminPage, ProviderAdmin } from '../lib/admin.ts';
import { useAdminVerdict } from './adminAccess.ts';
import type { ProviderError } from '../lib/provider.ts';
import { useT } from './i18n.ts';
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
      return 'admin.errLastAdmin';
    case 'revision_conflict':
    case 'operation_conflict':
      return 'admin.errChanged';
    case 'self_report':
      return 'report.self';
    case 'message_deleted':
      return 'report.gone';
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
    (error: unknown) => (provider === null ? 'admin.failed' : adminErrorKey(provider.describeError(error, true))),
    [provider],
  );
}

/**
 * A paged list read from the server: the first page on mount and on each new
 * `load` (a new search), `more` at the end of the list, `refresh` from the
 * top. An answer for an older search or an older read is dropped.
 */
export function useAdminPages<T>(load: ((after: string | null) => Promise<AdminPage<T>>) | null) {
  const describe = useAdminError();
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  // Bumped by a pull; with `load`, names the read whose rows are shown.
  const [reads, setReads] = useState(0);
  const current = useMemo(() => ({ load, reads }), [load, reads]);
  const [shown, setShown] = useState<typeof current | null>(null);
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  }, [current]);

  // A new search keeps the old rows on screen until its first page replaces them.
  useEffect(() => {
    if (current.load === null) return;
    let alive = true;
    current.load(null).then(
      (page) => {
        if (!alive) return;
        setItems(page.items);
        setNext(page.next);
        setError(null);
      },
      (e: unknown) => {
        if (alive) setError(describe(e));
      },
    ).finally(() => {
      if (!alive) return;
      setShown(current);
      setRefreshing(false);
    });
    return () => {
      alive = false;
    };
  }, [current, describe]);

  const more = useCallback(() => {
    if (load === null || next === null || moreBusy || shown !== current) return;
    const asked = current;
    setMoreBusy(true);
    load(next).then(
      (page) => {
        if (latest.current !== asked) return;
        setItems((old) => [...old, ...page.items]);
        setNext(page.next);
      },
      (e: unknown) => {
        if (latest.current === asked) setError(describe(e));
      },
    ).finally(() => setMoreBusy(false));
  }, [load, next, moreBusy, shown, current, describe]);

  return {
    items,
    setItems,
    loading: (shown !== current && !refreshing) || moreBusy,
    refreshing,
    error,
    refresh: useCallback(() => {
      setRefreshing(true);
      setReads((n) => n + 1);
    }, []),
    more,
  };
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

/** A date, or a dash when the server does not know it. */
export function shortDate(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleDateString();
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
