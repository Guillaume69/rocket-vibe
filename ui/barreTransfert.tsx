import { StyleSheet, Text, View } from 'react-native';

import { type Couleurs, POLICES } from './theme.ts';
import { libelleProgression, useProgression } from './transferts.ts';

/**
 * Progression d'un transfert de pièce jointe, là où la pièce s'affiche. Deux
 * formes : une ligne (piste + pourcentage) sous un fichier, ou une
 * superposition sur une image ou une vidéo — un filet au bas de la vignette et
 * une pastille « ⬇ 37 % ». Rien quand aucun transfert n'est en cours.
 */
export function BarreTransfert({
  cle,
  c,
  rayon,
}: {
  cle: string | null;
  c: Couleurs;
  /** Superposition sur un média, aux coins de ce rayon ; absent = forme ligne. */
  rayon?: number;
}) {
  const p = useProgression(cle);
  if (p === undefined) return null;
  const remplissage = (
    <View
      style={[
        styles.remplissage,
        {
          width: p === null ? '100%' : `${Math.max(p * 100, 3)}%`,
          backgroundColor: c.accent,
          opacity: p === null ? 0.4 : 1,
        },
      ]}
    />
  );

  if (rayon === undefined) {
    return (
      <View style={styles.ligne}>
        <View style={[styles.piste, { backgroundColor: c.surfaceActive }]}>{remplissage}</View>
        <Text style={[styles.pourcentage, { color: c.texteSecondaire }]}>{libelleProgression(p)}</Text>
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: rayon, overflow: 'hidden' }]}>
      <View style={[styles.pastille, { backgroundColor: c.carte + 'D9' }]}>
        <Text style={[styles.pastilleTexte, { color: c.texte }]}>⬇ {libelleProgression(p)}</Text>
      </View>
      <View style={[styles.piste, styles.pisteMedia]}>{remplissage}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  ligne: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6 },
  piste: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  remplissage: { height: '100%', borderRadius: 2 },
  pourcentage: { fontFamily: POLICES.corpsSemi, fontSize: 12, minWidth: 36, textAlign: 'right' },
  pastille: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  pastilleTexte: { fontFamily: POLICES.corpsSemi, fontSize: 12 },
  pisteMedia: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 0,
    backgroundColor: '#00000066',
  },
});
