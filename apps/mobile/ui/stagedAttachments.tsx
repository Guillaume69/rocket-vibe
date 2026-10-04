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
  AttachmentPreview,
  formatSize,
  QualityBadge,
  type PendingFile,
} from './attachmentPreview.tsx';
import { useT } from './i18n.ts';
import { fileEmoji, isImage, shortFormat } from './mime.ts';
import type { SendQuality } from './attachmentQuality.ts';
import { type Colors, FONTS } from './theme.ts';

export type StagedAttachment = PendingFile & { key: number };

export function StagedAttachments({
  c,
  attachments: pieces,
  busy: occupe,
  onRemove: onRetirer,
  onOpen: onOuvrir,
  quality: qualite,
  onQuality: surQualite,
}: {
  c: Colors;
  attachments: StagedAttachment[];
  /** Envoi en cours : retrait et choix de qualité gelés. */
  busy: boolean;
  onRemove: (cle: number) => void;
  onOpen: (piece: StagedAttachment) => void;
  /** `null` quand aucune pièce n'est réductible. Vaut pour toutes celles qui le sont. */
  quality: SendQuality | null;
  onQuality: (qualite: SendQuality) => void;
}) {
  const vocaux = pieces.filter((p) => p.type.startsWith('audio/'));
  const autres = pieces.filter((p) => !p.type.startsWith('audio/'));
  return (
    <View>
      {vocaux.map((p) => (
        <AttachmentPreview
          key={p.key}
          c={c}
          file={p}
          busy={occupe}
          onRemove={() => onRetirer(p.key)}
        />
      ))}
      {autres.length > 0 && (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.row}
          >
            {autres.map((p) => (
              <Pastille
                key={p.key}
                c={c}
                attachment={p}
                busy={occupe}
                onRemove={() => onRetirer(p.key)}
                onOpen={() => onOuvrir(p)}
              />
            ))}
          </ScrollView>
          {qualite !== null && (
            <View style={styles.qualities}>
              {(['reduite', 'originale'] as const).map((q) => (
                <QualityBadge
                  key={q}
                  c={c}
                  which={q}
                  chosen={qualite === q}
                  busy={occupe}
                  onPick={surQualite}
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
  attachment: piece,
  busy: occupe,
  onRemove: onRetirer,
  onOpen: onOuvrir,
}: {
  c: Colors;
  attachment: StagedAttachment;
  busy: boolean;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  // Une vidéo locale a sa première image décodée par le pipeline d'images
  // d'Android ; ailleurs (ou en cas d'échec), la tuile à emoji.
  const [sansVignette, setSansVignette] = useState(false);
  const vignette =
    !sansVignette && (isImage(piece.type) || piece.type.startsWith('video/'));
  const meta = [shortFormat(piece.name, piece.type), formatSize(piece.size, t)]
    .filter((x) => x !== null)
    .join(' ');

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.duration(180)}
      style={[styles.badge, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <Pressable
        onPress={onOuvrir}
        style={({ pressed }) => [styles.body, { opacity: pressed ? 0.7 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('apercuPieceJointe.apercu', { nom: piece.name })}
      >
        {vignette ? (
          <Image
            source={{ uri: piece.uri }}
            style={styles.thumbnail}
            resizeMode="cover"
            onError={() => setSansVignette(true)}
          />
        ) : (
          <LinearGradient
            colors={c.neutralGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.thumbnail}
          >
            <Text style={styles.emoji}>{fileEmoji(piece.type)}</Text>
          </LinearGradient>
        )}
        <View style={styles.infos}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1} ellipsizeMode="middle">
            {piece.name}
          </Text>
          {meta !== '' && (
            <Text style={[styles.meta, { color: c.dimmed }]} numberOfLines={1}>
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
        style={({ pressed }) => [styles.remove, { opacity: occupe ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <Text style={[styles.removeGlyph, { color: c.secondaryText }]}>✕</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 6,
    paddingVertical: 6,
    maxWidth: 240,
  },
  body: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  thumbnail: {
    width: 40,
    height: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  emoji: { fontSize: 20 },
  infos: { flexShrink: 1, minWidth: 0, gap: 1 },
  name: { fontFamily: FONTS.corpsGras, fontSize: 13 },
  meta: { fontFamily: FONTS.body, fontSize: 11 },
  remove: { paddingHorizontal: 10, paddingVertical: 8 },
  removeGlyph: { fontFamily: FONTS.corpsSemi, fontSize: 14 },
  qualities: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
});
