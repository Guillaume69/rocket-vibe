/**
 * Ce que le serveur me dit à moi seul dans un salon : la réponse d'une
 * commande slash (salon introuvable, `/help`). Volatile comme la présence :
 * un magasin en mémoire, pas de SQLite. La dernière note d'un salon remplace
 * la précédente ; elle s'affiche au-dessus du composer jusqu'à ce qu'on la
 * ferme.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { arbreDuMessage } from '../lib/markdown.ts';
import { Appuyable } from './appuyable.tsx';
import { useT } from './i18n.ts';
import { CorpsMessage, GardeRendu } from './markdown.tsx';
import { type Couleurs, POLICES } from './theme.ts';

const notes = new Map<string, string>();
const ecouteurs = new Set<() => void>();

function notifier(): void {
  for (const e of ecouteurs) e();
}

export function poserNotePrivee(rid: string, texte: string): void {
  notes.set(rid, texte);
  notifier();
}

export function fermerNotePrivee(rid: string): void {
  if (notes.delete(rid)) notifier();
}

function abonner(e: () => void): () => void {
  ecouteurs.add(e);
  return () => ecouteurs.delete(e);
}

export function useNotePrivee(rid: string): string | null {
  const lire = useCallback(() => notes.get(rid) ?? null, [rid]);
  return useSyncExternalStore(abonner, lire);
}

export function NotePrivee({ c, rid, texte }: { c: Couleurs; rid: string; texte: string }) {
  const t = useT();
  const arbre = useMemo(() => arbreDuMessage(null, texte), [texte]);
  return (
    <View style={[styles.note, { backgroundColor: c.carte, borderLeftColor: c.accent }]}>
      <View style={styles.corps}>
        <Text style={[styles.titre, { color: c.accent }]}>{t('salon.notePrivee')}</Text>
        {arbre === null ? (
          <Text style={{ color: c.texte }}>{texte}</Text>
        ) : (
          <GardeRendu key={texte} repli={<Text style={{ color: c.texte }}>{texte}</Text>}>
            <CorpsMessage arbre={arbre} c={c} />
          </GardeRendu>
        )}
      </View>
      <Appuyable
        onPress={() => fermerNotePrivee(rid)}
        android_ripple={{ color: c.ondulation, borderless: true }}
        style={styles.fermer}
        accessibilityLabel={t('commun.fermer')}
      >
        <Text style={{ color: c.attenue }}>✕</Text>
      </Appuyable>
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
  corps: { flex: 1, gap: 2 },
  titre: { fontFamily: POLICES.corps, fontSize: 12, fontWeight: '700' },
  fermer: { paddingHorizontal: 10, paddingVertical: 2 },
});
