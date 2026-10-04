/**
 * Lecture d'une pièce jointe vidéo (expo-video).
 *
 * Avant : une vidéo tombait dans la branche générique « 📄 fichier » et ne
 * s'ouvrait que dans le navigateur — donc illisible dans l'app. Ici on montre
 * dans le fil une CARTE d'aperçu themée (bannière « aurore » + gros bouton de
 * lecture), et un toucher ouvre le lecteur PLEIN ÉCRAN, contrôles natifs
 * (play/pause, glissière, plein écran), sur le modèle de la visionneuse image.
 *
 * Deux partis pris :
 *  - **Le player n'existe que lorsqu'on regarde.** `useVideoPlayer` crée une
 *    instance native coûteuse ; un fil peut aligner plusieurs vidéos. On ne
 *    monte `ModaleVideo` (et donc le player) qu'à l'ouverture, et il est libéré
 *    à la fermeture (démontage). La carte, elle, ne coûte rien.
 *  - **L'URL protégée reste en mémoire.** Comme pour l'image, elle porte
 *    `rc_uid`/`rc_token` : jamais dans un paramètre de route, seulement dans une
 *    `Modal` native au-dessus de la pile.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from './i18n.ts';
import { type Colors, FONTS } from './theme.ts';

export function VideoPlayer({
  c,
  url,
  title,
  onLongPress,
  overlay,
}: {
  c: Colors;
  url: string;
  title?: string | null;
  onLongPress?: (() => void) | undefined;
  /** Rendue par-dessus la carte (progression d'un téléchargement). */
  overlay?: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={[styles.card, { borderColor: c.border }]}
        accessibilityRole="button"
        accessibilityLabel={title ? t('lecteurVideo.lireAvecTitre', { titre: title }) : t('lecteurVideo.lire')}
      >
        {/* Aurore comète, tamisée par un voile sombre : un rappel de couleur
            sans que la carte crie. */}
        <LinearGradient
          colors={c.brandGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.mediaScrim }]} />

        <LinearGradient
          colors={c.ctaGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {/* Triangle DESSINÉ, pas un emoji (« ▶ » sort orange sur Android). */}
          <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
        </LinearGradient>

        <View style={styles.footer}>
          <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>
            {title ?? t('lecteurVideo.video')}
          </Text>
        </View>
        {overlay}
      </Pressable>

      {open && <VideoModal c={c} url={url} title={title ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

export function VideoModal({
  c,
  url,
  title,
  onClose,
}: {
  c: Colors;
  url: string;
  title: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  // Le player naît ici (donc à l'ouverture) et meurt au démontage : pas
  // d'instance native pour les vidéos qu'on ne regarde pas. Lecture immédiate,
  // l'utilisateur a touché « lire ».
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      <View style={[styles.background, { backgroundColor: c.fullScreenBackground }]}>
        <VideoView
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls
          allowsPictureInPicture={false}
        />
      </View>

      {/* Croix de fermeture, sa propre cible au-dessus du lecteur. */}
      <Pressable
        onPress={onClose}
        hitSlop={12}
        style={[styles.close, { top: insets.top + 8, backgroundColor: c.card + 'D9' }]}
        accessibilityRole="button"
        accessibilityLabel={t('commun.fermer')}
      >
        <Text style={[styles.cross, { color: c.text }]}>✕</Text>
      </Pressable>

      {title != null && title !== '' && (
        <View style={[styles.caption, { bottom: insets.bottom + 12 }]} pointerEvents="none">
          <Text style={[styles.captionText, { color: c.text }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 240,
    maxWidth: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    width: 0,
    height: 0,
    borderTopWidth: 11,
    borderBottomWidth: 11,
    borderLeftWidth: 18,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4, // recentrage optique du triangle
  },
  footer: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 8,
  },
  label: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  // La couleur (`fondPleinEcran`) vient du thème, posée au rendu.
  background: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cross: { fontFamily: FONTS.bodyStrong, fontSize: 17, lineHeight: 20 },
  caption: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  captionText: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center' },
});
