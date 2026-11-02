import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { messageTree } from '../lib/markdown.ts';
import { NOTES_CONFLICT, type ProviderActions, type RoomNotes } from '../lib/provider.ts';
import { useT, useTimeFormatter } from '../ui/i18n.ts';
import { MessageBody, RenderGuard } from '../ui/markdown.tsx';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

/**
 * A room's notes: the markdown rendered like a message, an edit mode on the
 * raw text, saved whole against the revision it was read at. A save someone
 * made in between keeps the draft and says so; saving again goes over it.
 */

const REFRESH_MS = 10_000;

export default function NotesScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();

  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('notes.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <Notes c={c} actions={sync.actions} rid={rid} />;
}

type Phase = { phase: 'loading' } | { phase: 'ready'; notes: RoomNotes } | { phase: 'error' };

function Notes({ c, actions, rid }: { c: Colors; actions: ProviderActions; rid: string }) {
  const t = useT();
  const formatTime = useTimeFormatter();
  const [state, setState] = useState<Phase>({ phase: 'loading' });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editing = draft !== null;
  const editingRef = useRef(editing);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const load = useCallback(async () => {
    if (!actions.roomNotes) return;
    try {
      const notes = await actions.roomNotes(rid);
      setState({ phase: 'ready', notes });
    } catch {
      setState((current) => (current.phase === 'ready' ? current : { phase: 'error' }));
    }
  }, [actions, rid]);

  useEffect(() => {
    let alive = true;
    const read = () => {
      actions.roomNotes?.(rid).then(
        (notes) => { if (alive) setState({ phase: 'ready', notes }); },
        () => { if (alive) setState((current) => (current.phase === 'ready' ? current : { phase: 'error' })); },
      );
    };
    read();
    // A save elsewhere publishes the room; while shown, read again now and then.
    const timer = setInterval(() => { if (!editingRef.current) read(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [actions, rid]);

  const save = async () => {
    if (state.phase !== 'ready' || draft === null || !actions.saveRoomNotes) return;
    setSaving(true);
    try {
      const notes = await actions.saveRoomNotes(rid, draft, state.notes.revision);
      setState({ phase: 'ready', notes });
      setDraft(null);
      setNotice(null);
    } catch (e) {
      if ((e as { code?: string }).code === NOTES_CONFLICT) {
        // The draft stays; the next save goes over the newer version.
        await load();
        setNotice(t('notes.conflict'));
      } else {
        setNotice(t('notes.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const notes = state.phase === 'ready' ? state.notes : null;
  const tree = useMemo(() => (notes && notes.markdown.trim() !== '' ? messageTree(null, notes.markdown) : null), [notes]);
  const edited = notes?.updatedBy && notes.updatedAt !== null
    ? t('notes.edited', { name: notes.updatedBy, time: formatTime(notes.updatedAt) })
    : null;

  const header = () => {
    if (editing) {
      return (
        <View style={styles.actions}>
          <HeaderButton c={c} label={t('notes.cancel')} onPress={() => { setDraft(null); setNotice(null); }} />
          <HeaderButton c={c} label={t('notes.save')} onPress={() => void save()} disabled={saving} strong />
        </View>
      );
    }
    if (notes?.editable) {
      return <HeaderButton c={c} label={t('notes.edit')} onPress={() => { setDraft(notes.markdown); setNotice(null); }} />;
    }
    return null;
  };

  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: c.background }]} behavior="padding">
      <Stack.Screen options={{ title: t('notes.title'), headerRight: header }} />
      {notice !== null && <Text style={[styles.notice, { color: c.accent }]}>{notice}</Text>}
      {state.phase === 'loading' && <View style={styles.center}><ActivityIndicator /></View>}
      {state.phase === 'error' && <Text style={[styles.empty, { color: c.secondaryText }]}>{t('notes.loadFailed')}</Text>}
      {state.phase === 'ready' && editing && (
        <TextInput
          style={[styles.editor, { color: c.text, borderColor: c.border }]}
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          textAlignVertical="top"
          accessibilityLabel={t('notes.title')}
        />
      )}
      {state.phase === 'ready' && !editing && (
        <ScrollView contentContainerStyle={styles.content}>
          {tree === null
            ? <Text style={[styles.empty, { color: c.secondaryText }]}>{t('notes.empty')}</Text>
            : <RenderGuard key={notes?.revision} fallback={<Text style={{ color: c.text }}>{notes?.markdown}</Text>}><MessageBody tree={tree} c={c} /></RenderGuard>}
          {edited !== null && <Text style={[styles.edited, { color: c.secondaryText }]}>{edited}</Text>}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

function HeaderButton({ c, label, onPress, disabled = false, strong = false }: { c: Colors; label: string; onPress: () => void; disabled?: boolean; strong?: boolean }) {
  return (
    <Tappable onPress={onPress} disabled={disabled} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.headerButton, { color: c.accent, fontFamily: strong ? FONTS.bodySemi : FONTS.body, opacity: disabled ? 0.5 : 1 }]}>{label}</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 12 },
  empty: { padding: 16, fontFamily: FONTS.body, fontSize: 15 },
  edited: { fontFamily: FONTS.body, fontSize: 12 },
  notice: { paddingHorizontal: 16, paddingTop: 10, fontFamily: FONTS.body, fontSize: 13 },
  editor: { flex: 1, margin: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, fontFamily: 'monospace', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 16 },
  headerButton: { fontSize: 15, paddingHorizontal: 4 },
});
