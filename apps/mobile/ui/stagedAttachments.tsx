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
  attachments,
  busy,
  onRemove,
  onOpen,
  quality,
  onQuality,
}: {
  c: Colors;
  attachments: StagedAttachment[];
  /** Envoi en cours : retrait et choix de qualité gelés. */
  busy: boolean;
  onRemove: (key: number) => void;
  onOpen: (attachment: StagedAttachment) => void;
  /** `null` quand aucune pièce n'est réductible. Vaut pour toutes celles qui le sont. */
  quality: SendQuality | null;
  onQuality: (quality: SendQuality) => void;
}) {
  const voice = attachments.filter((p) => p.type.startsWith('audio/'));
  const others = attachments.filter((p) => !p.type.startsWith('audio/'));
  return (
    <View>
      {voice.map((p) => (
        <AttachmentPreview
          key={p.key}
          c={c}
          file={p}
          busy={busy}
          onRemove={() => onRemove(p.key)}
        />
      ))}
      {others.length > 0 && (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.row}
          >
            {others.map((p) => (
              <Chip
                key={p.key}
                c={c}
                attachment={p}
                busy={busy}
                onRemove={() => onRemove(p.key)}
                onOpen={() => onOpen(p)}
              />
            ))}
          </ScrollView>
          {quality !== null && (
            <View style={styles.qualities}>
              {(['reduced', 'original'] as const).map((q) => (
                <QualityBadge
                  key={q}
                  c={c}
                  which={q}
                  chosen={quality === q}
                  busy={busy}
                  onPick={onQuality}
                />
              ))}
            </View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

function Chip({
  c,
  attachment,
  busy,
  onRemove,
  onOpen,
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
  const [withoutThumbnail, setWithoutThumbnail] = useState(false);
  const thumbnail =
    !withoutThumbnail && (isImage(attachment.type) || attachment.type.startsWith('video/'));
  const meta = [shortFormat(attachment.name, attachment.type), formatSize(attachment.size, t)]
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
        onPress={onOpen}
        style={({ pressed }) => [styles.body, { opacity: pressed ? 0.7 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('apercuPieceJointe.apercu', { nom: attachment.name })}
      >
        {thumbnail ? (
          <Image
            source={{ uri: attachment.uri }}
            style={styles.thumbnail}
            resizeMode="cover"
            onError={() => setWithoutThumbnail(true)}
          />
        ) : (
          <LinearGradient
            colors={c.neutralGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.thumbnail}
          >
            <Text style={styles.emoji}>{fileEmoji(attachment.type)}</Text>
          </LinearGradient>
        )}
        <View style={styles.info}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1} ellipsizeMode="middle">
            {attachment.name}
          </Text>
          {meta !== '' && (
            <Text style={[styles.meta, { color: c.dimmed }]} numberOfLines={1}>
              {meta}
            </Text>
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={onRemove}
        disabled={busy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('apercuPieceJointe.retirer')}
        style={({ pressed }) => [styles.remove, { opacity: busy ? 0.4 : pressed ? 0.6 : 1 }]}
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
  info: { flexShrink: 1, minWidth: 0, gap: 1 },
  name: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  meta: { fontFamily: FONTS.body, fontSize: 11 },
  remove: { paddingHorizontal: 10, paddingVertical: 8 },
  removeGlyph: { fontFamily: FONTS.bodySemi, fontSize: 14 },
  qualities: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 4 },
});
