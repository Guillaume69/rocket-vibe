/**
 * Ce que le serveur me dit à moi seul dans un salon : la réponse d'une
 * commande slash (salon introuvable, `/help`). Volatile comme la présence :
 * un magasin en mémoire, pas de SQLite. La dernière note d'un salon remplace
 * la précédente ; elle s'affiche au-dessus du composer jusqu'à ce qu'on la
 * ferme.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { messageTree } from '../lib/markdown.ts';
import { Tappable } from './tappable.tsx';
import { useT } from './i18n.ts';
import { MessageBody, RenderGuard } from './markdown.tsx';
import { type Colors, FONTS } from './theme.ts';

const notes = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const e of listeners) e();
}

export function setPrivateNote(rid: string, text: string): void {
  notes.set(rid, text);
  notify();
}

export function closePrivateNote(rid: string): void {
  if (notes.delete(rid)) notify();
}

function subscribe(e: () => void): () => void {
  listeners.add(e);
  return () => listeners.delete(e);
}

export function usePrivateNote(rid: string): string | null {
  const read = useCallback(() => notes.get(rid) ?? null, [rid]);
  return useSyncExternalStore(subscribe, read);
}

export function PrivateNote({ c, rid, text }: { c: Colors; rid: string; text: string }) {
  const t = useT();
  const tree = useMemo(() => messageTree(null, text), [text]);
  return (
    <View style={[styles.note, { backgroundColor: c.card, borderLeftColor: c.accent }]}>
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.accent }]}>{t('room.privateNote')}</Text>
        {tree === null ? (
          <Text style={{ color: c.text }}>{text}</Text>
        ) : (
          <RenderGuard key={text} fallback={<Text style={{ color: c.text }}>{text}</Text>}>
            <MessageBody tree={tree} c={c} />
          </RenderGuard>
        )}
      </View>
      <Tappable
        onPress={() => closePrivateNote(rid)}
        android_ripple={{ color: c.ripple, borderless: true }}
        style={styles.close}
        accessibilityLabel={t('common.close')}
      >
        <Text style={{ color: c.dimmed }}>✕</Text>
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: 12,
    marginTop: 6,
    paddingVertical: 6,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderRadius: 10,
  },
  body: { flex: 1, gap: 2 },
  title: { fontFamily: FONTS.body, fontSize: 12, fontWeight: '700' },
  close: { paddingHorizontal: 10, paddingVertical: 2 },
});
