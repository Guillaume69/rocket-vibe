/**
 * Aperçu d'une pièce jointe EN ATTENTE d'envoi — le « buffer » avant l'envoi.
 *
 * Avant, choisir un fichier ou finir un enregistrement l'envoyait aussitôt.
 * Ici la pièce se pose d'abord au-dessus du composer : on la voit, on peut
 * écrire une légende, puis on envoie le tout en UN SEUL message — comme l'app
 * officielle. Le retrait (✕) la jette sans rien envoyer.
 *
 * L'apparition POUSSE nativement la liste (le composer grandit, la liste
 * `flex: 1` se comprime, contenu inversé collé au bas → le dernier message
 * remonte). Trois rendus selon le type : vignette pour une image, LECTEUR RÉEL
 * pour l'audio (on se réécoute avant d'envoyer, `LecteurAudio` réutilisé),
 * tuile à emoji pour tout autre fichier.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { useT } from './i18n.ts';
import { AudioPlayer } from './audioPlayer.tsx';
import type { TranslateFn } from './messages.ts';
import { fileEmoji, isImage } from './mime.ts';
import type { SendQuality } from './attachmentQuality.ts';
import { type Colors, FONTS } from './theme.ts';

export type PendingFile = {
  uri: string;
  name: string;
  /** MIME. Validé à la pose et à l'envoi contre `FileUpload_MediaTypeWhiteList`. */
  type: string;
  size: number | null;
};

export function formatSize(bytes: number | null, t: TranslateFn): string | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes < 1024) return t('apercuPieceJointe.octets', { taille: bytes });
  if (bytes < 1024 * 1024) return t('apercuPieceJointe.kilooctets', { taille: Math.round(bytes / 1024) });
  return t('apercuPieceJointe.megaoctets', { taille: (bytes / 1024 / 1024).toFixed(1) });
}

export function AttachmentPreview({
  c,
  file,
  onRemove,
  busy = false,
  horizontalInset = 12,
  verticalInset,
  quality = null,
  onQuality,
}: {
  c: Colors;
  file: PendingFile;
  onRemove: () => void;
  /** Envoi en cours : le retrait est gelé (le fichier est déjà en vol). */
  busy?: boolean;
  /**
   * Choix de qualité (pastilles Réduite/Originale) — `null` quand il n'y a
   * rien à choisir (audio, document, image légère, ou écran sans réduction).
   * La réduction elle-même se fait à l'ENVOI, chez l'appelant.
   */
  quality?: SendQuality | null;
  onQuality?: (quality: SendQuality) => void;
  /**
   * Retrait horizontal de la carte. 12 par défaut : dans le composeur du salon,
   * le parent n'a pas de padding, la carte s'inset donc elle-même. Quand
   * l'appelant est déjà dans un conteneur padé (écran de partage), passer 0
   * pour aligner la carte sur les autres champs.
   */
  horizontalInset?: number;
  /**
   * Retrait vertical propre de la carte. Non défini : garde l'espacement du
   * composeur (8/10). Quand plusieurs cartes s'empilent (écran de partage),
   * passer 0 et laisser le conteneur gérer l'espacement, sinon les cartes sont
   * trop écartées.
   */
  verticalInset?: number;
}) {
  const t = useT();
  const isImageFile = isImage(file.type);
  const isAudio = file.type.startsWith('audio/');
  const size = formatSize(file.size, t);

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(140)}
      style={[
        styles.host,
        { paddingHorizontal: horizontalInset },
        verticalInset !== undefined && { paddingVertical: verticalInset },
      ]}
    >
      {isAudio ? (
        // Le vocal se réécoute AVANT d'envoyer : le vrai lecteur, pas une icône.
        <View style={styles.row}>
          <View style={styles.full}>
            <AudioPlayer c={c} url={file.uri} title={t('lecteurAudio.messageVocal')} />
          </View>
          <RemoveButton c={c} onRemove={onRemove} busy={busy} />
        </View>
      ) : (
        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          {isImageFile ? (
            <Image source={{ uri: file.uri }} style={styles.thumbnail} resizeMode="cover" />
          ) : (
            <LinearGradient
              colors={c.neutralGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.thumbnail}
            >
              <Text style={styles.emoji}>{fileEmoji(file.type)}</Text>
            </LinearGradient>
          )}
          <View style={styles.info}>
            <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={[styles.meta, { color: c.dimmed }]} numberOfLines={1}>
              {isImageFile ? t('apercuPieceJointe.image') : file.type || t('apercuPieceJointe.fichier')}
              {size !== null ? ` · ${size}` : ''}
            </Text>
            {quality !== null && onQuality !== undefined && (
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
          </View>
          <RemoveButton c={c} onRemove={onRemove} busy={busy} />
        </View>
      )}
    </Animated.View>
  );
}

/**
 * Une des deux pastilles du choix de qualité. Gelée pendant l'envoi (`occupe`) :
 * la version qui part est déjà en cours de préparation, changer d'avis ici ne
 * serait qu'un mensonge d'affichage.
 */
export function QualityBadge({
  c,
  which,
  chosen,
  busy,
  onPick,
}: {
  c: Colors;
  which: SendQuality;
  chosen: boolean;
  busy: boolean;
  onPick: (quality: SendQuality) => void;
}) {
  const t = useT();
  return (
    <Pressable
      onPress={() => onPick(which)}
      disabled={busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ selected: chosen }}
      accessibilityLabel={t(
        which === 'reduced'
          ? 'apercuPieceJointe.envoyerReduite'
          : 'apercuPieceJointe.envoyerOriginale',
      )}
      style={[
        styles.badge,
        {
          borderColor: chosen ? c.accent : c.border,
          backgroundColor: chosen ? c.surfaceActive : 'transparent',
          opacity: busy ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[styles.badgeText, { color: chosen ? c.text : c.dimmed }]}
        numberOfLines={1}
      >
        {t(which === 'reduced' ? 'apercuPieceJointe.reduite' : 'apercuPieceJointe.originale')}
      </Text>
    </Pressable>
  );
}

function RemoveButton({
  c,
  onRemove,
  busy,
}: {
  c: Colors;
  onRemove: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Pressable
      onPress={onRemove}
      disabled={busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('apercuPieceJointe.retirer')}
      style={({ pressed }) => [
        styles.remove,
        {
          backgroundColor: c.surfaceActive,
          borderColor: c.border,
          opacity: busy ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text style={[styles.removeGlyph, { color: c.secondaryText }]}>×</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { paddingTop: 8, paddingBottom: 10 },
  full: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    padding: 8,
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  emoji: { fontSize: 26 },
  info: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: FONTS.bodyBold, fontSize: 13.5 },
  meta: { fontFamily: FONTS.body, fontSize: 11 },
  qualities: { flexDirection: 'row', gap: 6, marginTop: 3 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  badgeText: { fontFamily: FONTS.bodySemi, fontSize: 11 },
  remove: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: { fontFamily: FONTS.bodySemi, fontSize: 20, lineHeight: 22 },
});
