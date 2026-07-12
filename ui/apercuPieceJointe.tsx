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

import { LecteurAudio } from './lecteurAudio.tsx';
import { type Couleurs, POLICES } from './theme.ts';

export type FichierEnAttente = {
  uri: string;
  nom: string;
  /** MIME. Validé à l'envoi contre `FileUpload_MediaTypeWhiteList`. */
  type: string;
  taille: number | null;
};

/** Émoji d'après la famille MIME, pour les fichiers non-image / non-audio. */
function emojiFichier(type: string): string {
  if (type.startsWith('video/')) return '🎬';
  if (type === 'application/pdf') return '📄';
  if (type.startsWith('text/')) return '📃';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

function formaterTaille(octets: number | null): string | null {
  if (octets === null || octets <= 0) return null;
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / 1024 / 1024).toFixed(1)} Mo`;
}

export function ApercuPieceJointe({
  c,
  fichier,
  onRetirer,
  occupe = false,
  retraitHorizontal = 12,
  retraitVertical,
}: {
  c: Couleurs;
  fichier: FichierEnAttente;
  onRetirer: () => void;
  /** Envoi en cours : le retrait est gelé (le fichier est déjà en vol). */
  occupe?: boolean;
  /**
   * Retrait horizontal de la carte. 12 par défaut : dans le composeur du salon,
   * le parent n'a pas de padding, la carte s'inset donc elle-même. Quand
   * l'appelant est déjà dans un conteneur padé (écran de partage), passer 0
   * pour aligner la carte sur les autres champs.
   */
  retraitHorizontal?: number;
  /**
   * Retrait vertical propre de la carte. Non défini : garde l'espacement du
   * composeur (8/10). Quand plusieurs cartes s'empilent (écran de partage),
   * passer 0 et laisser le conteneur gérer l'espacement, sinon les cartes sont
   * trop écartées.
   */
  retraitVertical?: number;
}) {
  const estImage = fichier.type.startsWith('image/');
  const estAudio = fichier.type.startsWith('audio/');
  const taille = formaterTaille(fichier.taille);

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(140)}
      style={[
        styles.hote,
        { paddingHorizontal: retraitHorizontal },
        retraitVertical !== undefined && { paddingVertical: retraitVertical },
      ]}
    >
      {estAudio ? (
        // Le vocal se réécoute AVANT d'envoyer : le vrai lecteur, pas une icône.
        <View style={styles.rangee}>
          <View style={styles.plein}>
            <LecteurAudio c={c} url={fichier.uri} titre="Message vocal" />
          </View>
          <BoutonRetirer c={c} onRetirer={onRetirer} occupe={occupe} />
        </View>
      ) : (
        <View style={[styles.carte, { backgroundColor: c.carte, borderColor: c.bordure }]}>
          {estImage ? (
            <Image source={{ uri: fichier.uri }} style={styles.vignette} resizeMode="cover" />
          ) : (
            <LinearGradient
              colors={c.degradeNeutre}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.vignette}
            >
              <Text style={styles.emoji}>{emojiFichier(fichier.type)}</Text>
            </LinearGradient>
          )}
          <View style={styles.infos}>
            <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1}>
              {fichier.nom}
            </Text>
            <Text style={[styles.meta, { color: c.attenue }]} numberOfLines={1}>
              {estImage ? 'Image' : fichier.type || 'Fichier'}
              {taille !== null ? ` · ${taille}` : ''}
            </Text>
          </View>
          <BoutonRetirer c={c} onRetirer={onRetirer} occupe={occupe} />
        </View>
      )}
    </Animated.View>
  );
}

function BoutonRetirer({
  c,
  onRetirer,
  occupe,
}: {
  c: Couleurs;
  onRetirer: () => void;
  occupe: boolean;
}) {
  return (
    <Pressable
      onPress={onRetirer}
      disabled={occupe}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Retirer la pièce jointe"
      style={({ pressed }) => [
        styles.retirer,
        {
          backgroundColor: c.surfaceActive,
          borderColor: c.bordure,
          opacity: occupe ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text style={[styles.retirerGlyphe, { color: c.texteSecondaire }]}>×</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hote: { paddingTop: 8, paddingBottom: 10 },
  plein: { flex: 1 },
  rangee: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  carte: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    padding: 8,
  },
  vignette: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  emoji: { fontSize: 26 },
  infos: { flex: 1, minWidth: 0, gap: 2 },
  nom: { fontFamily: POLICES.corpsGras, fontSize: 13.5 },
  meta: { fontFamily: POLICES.corps, fontSize: 11 },
  retirer: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retirerGlyphe: { fontFamily: POLICES.corpsSemi, fontSize: 20, lineHeight: 22 },
});
