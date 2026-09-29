/**
 * Les pièces jointes qui ATTENDENT l'envoi, en pastilles au-dessus du champ —
 * comme Rocket.Chat web. Chaque pastille montre une vignette (image, vidéo) ou
 * une tuile à emoji, le nom, le format et le poids, et un ✕ pour la retirer ;
 * la toucher ouvre un aperçu. Un vocal garde son lecteur, pour se réécouter.
 * Le texte tapé part en légende de la PREMIÈRE pièce (voir `ui/composer.tsx`).
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import {
  ApercuPieceJointe,
  formaterTaille,
  PastilleQualite,
  type FichierEnAttente,
} from './apercuPieceJointe.tsx';
import { useT } from './i18n.ts';
import { emojiFichier, estImage, formatCourt } from './mime.ts';
import type { QualiteEnvoi } from './qualitePieceJointe.ts';
import { type Couleurs, POLICES } from './theme.ts';

export type PieceEnAttente = FichierEnAttente & { cle: number };

export function PiecesEnAttente({
  c,
  pieces,
  occupe,
  onRetirer,
  onOuvrir,
  qualite,
  surQualite,
}: {
  c: Couleurs;
  pieces: PieceEnAttente[];
  /** Envoi en cours : retrait et choix de qualité gelés. */
  occupe: boolean;
  onRetirer: (cle: number) => void;
  onOuvrir: (piece: PieceEnAttente) => void;
  /** `null` quand aucune pièce n'est réductible. Vaut pour toutes celles qui le sont. */
  qualite: QualiteEnvoi | null;
  surQualite: (qualite: QualiteEnvoi) => void;
}) {
  const vocaux = pieces.filter((p) => p.type.startsWith('audio/'));
  const autres = pieces.filter((p) => !p.type.startsWith('audio/'));
  return (
    <View>
      {vocaux.map((p) => (
        <ApercuPieceJointe
          key={p.cle}
          c={c}
          fichier={p}
          occupe={occupe}
          onRetirer={() => onRetirer(p.cle)}
        />
      ))}
      {autres.length > 0 && (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.rangee}
          >
            {autres.map((p) => (
              <Pastille
                key={p.cle}
                c={c}
                piece={p}
                occupe={occupe}
                onRetirer={() => onRetirer(p.cle)}
                onOuvrir={() => onOuvrir(p)}
              />
            ))}
          </ScrollView>
          {qualite !== null && (
            <View style={styles.qualites}>
              {(['reduite', 'originale'] as const).map((q) => (
                <PastilleQualite
                  key={q}
                  c={c}
                  quelle={q}
                  choisie={qualite === q}
                  occupe={occupe}
                  surChoisir={surQualite}
                />
              ))}
            </View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

function Pastille({
  c,
  piece,
  occupe,
  onRetirer,
  onOuvrir,
}: {
  c: Couleurs;
  piece: PieceEnAttente;
  occupe: boolean;
  onRetirer: () => void;
  onOuvrir: () => void;
}) {
  const t = useT();
  // Une vidéo locale a sa première image décodée par le pipeline d'images
  // d'Android ; ailleurs (ou en cas d'échec), la tuile à emoji.
  const [sansVignette, setSansVignette] = useState(false);
  const vignette =
    !sansVignette && (estImage(piece.type) || piece.type.startsWith('video/'));
  const meta = [formatCourt(piece.nom, piece.type), formaterTaille(piece.taille, t)]
    .filter((x) => x !== null)
    .join(' ');

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.duration(180)}
      style={[styles.pastille, { backgroundColor: c.carte, borderColor: c.bordure }]}
    >
      <Pressable
        onPress={onOuvrir}
        style={({ pressed }) => [styles.corps, { opacity: pressed ? 0.7 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('apercuPieceJointe.apercu', { nom: piece.nom })}
      >
        {vignette ? (
          <Image
            source={{ uri: piece.uri }}
            style={styles.vignette}
            resizeMode="cover"
            onError={() => setSansVignette(true)}
          />
        ) : (
          <LinearGradient
            colors={c.degradeNeutre}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.vignette}
          >
            <Text style={styles.emoji}>{emojiFichier(piece.type)}</Text>
          </LinearGradient>
        )}
        <View style={styles.infos}>
          <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1} ellipsizeMode="middle">
            {piece.nom}
          </Text>
          {meta !== '' && (
            <Text style={[styles.meta, { color: c.attenue }]} numberOfLines={1}>
              {meta}
            </Text>
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={onRetirer}
        disabled={occupe}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('apercuPieceJointe.retirer')}
        style={({ pressed }) => [styles.retirer, { opacity: occupe ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Text style={[styles.retirerGlyphe, { color: c.texteSecondaire }]}>✕</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  rangee: { gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  pastille: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 6,
    paddingVertical: 6,
    maxWidth: 240,
  },
  corps: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  vignette: {
    width: 40,
    height: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  emoji: { fontSize: 20 },
  infos: { flexShrink: 1, minWidth: 0, gap: 1 },
  nom: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  meta: { fontFamily: POLICES.corps, fontSize: 11 },
  retirer: { paddingHorizontal: 10, paddingVertical: 8 },
  retirerGlyphe: { fontFamily: POLICES.corpsSemi, fontSize: 14 },
  qualites: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
});
