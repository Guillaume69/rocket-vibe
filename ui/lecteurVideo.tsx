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
import { type Couleurs, POLICES } from './theme.ts';

export function LecteurVideo({
  c,
  url,
  titre,
  surAppuiLong,
  superposition,
}: {
  c: Couleurs;
  url: string;
  titre?: string | null;
  surAppuiLong?: (() => void) | undefined;
  /** Rendue par-dessus la carte (progression d'un téléchargement). */
  superposition?: React.ReactNode;
}) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOuvert(true)}
        onLongPress={surAppuiLong}
        delayLongPress={350}
        style={[styles.carte, { borderColor: c.bordure }]}
        accessibilityRole="button"
        accessibilityLabel={titre ? t('lecteurVideo.lireAvecTitre', { titre }) : t('lecteurVideo.lire')}
      >
        {/* Aurore comète, tamisée par un voile sombre : un rappel de couleur
            sans que la carte crie. */}
        <LinearGradient
          colors={c.degradeMarque}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.voileMedia }]} />

        <LinearGradient
          colors={c.degradeCta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.bouton}
        >
          {/* Triangle DESSINÉ, pas un emoji (« ▶ » sort orange sur Android). */}
          <View style={[styles.iconePlay, { borderLeftColor: c.surAccent }]} />
        </LinearGradient>

        <View style={styles.pied}>
          <Text style={[styles.etiquette, { color: c.texte }]} numberOfLines={1}>
            {titre ?? t('lecteurVideo.video')}
          </Text>
        </View>
        {superposition}
      </Pressable>

      {ouvert && <ModaleVideo c={c} url={url} titre={titre ?? null} onFermer={() => setOuvert(false)} />}
    </>
  );
}

function ModaleVideo({
  c,
  url,
  titre,
  onFermer,
}: {
  c: Couleurs;
  url: string;
  titre: string | null;
  onFermer: () => void;
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
      onRequestClose={onFermer}
      supportedOrientations={['portrait', 'landscape']}
    >
      <View style={[styles.fond, { backgroundColor: c.fondPleinEcran }]}>
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
        onPress={onFermer}
        hitSlop={12}
        style={[styles.fermer, { top: insets.top + 8, backgroundColor: c.carte + 'D9' }]}
        accessibilityRole="button"
        accessibilityLabel={t('commun.fermer')}
      >
        <Text style={[styles.croix, { color: c.texte }]}>✕</Text>
      </Pressable>

      {titre != null && titre !== '' && (
        <View style={[styles.legende, { bottom: insets.bottom + 12 }]} pointerEvents="none">
          <Text style={[styles.legendeTexte, { color: c.texte }]} numberOfLines={2}>
            {titre}
          </Text>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  carte: {
    width: 240,
    maxWidth: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bouton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconePlay: {
    width: 0,
    height: 0,
    borderTopWidth: 11,
    borderBottomWidth: 11,
    borderLeftWidth: 18,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4, // recentrage optique du triangle
  },
  pied: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 8,
  },
  etiquette: { fontFamily: POLICES.corpsSemi, fontSize: 12 },
  // La couleur (`fondPleinEcran`) vient du thème, posée au rendu.
  fond: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%' },
  fermer: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  croix: { fontFamily: POLICES.corpsFort, fontSize: 17, lineHeight: 20 },
  legende: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  legendeTexte: { fontFamily: POLICES.corps, fontSize: 13, textAlign: 'center' },
});
