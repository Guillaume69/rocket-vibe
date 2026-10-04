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
import { LecteurAudio } from './audioPlayer.tsx';
import type { Traducteur } from './messages.ts';
import { emojiFichier, estImage } from './mime.ts';
import type { QualiteEnvoi } from './attachmentQuality.ts';
import { type Couleurs, POLICES } from './theme.ts';

export type FichierEnAttente = {
  uri: string;
  nom: string;
  /** MIME. Validé à la pose et à l'envoi contre `FileUpload_MediaTypeWhiteList`. */
  type: string;
  taille: number | null;
};

export function formaterTaille(octets: number | null, t: Traducteur): string | null {
  if (octets === null || octets <= 0) return null;
  if (octets < 1024) return t('apercuPieceJointe.octets', { taille: octets });
  if (octets < 1024 * 1024) return t('apercuPieceJointe.kilooctets', { taille: Math.round(octets / 1024) });
  return t('apercuPieceJointe.megaoctets', { taille: (octets / 1024 / 1024).toFixed(1) });
}

export function ApercuPieceJointe({
  c,
  fichier,
  onRetirer,
  occupe = false,
  retraitHorizontal = 12,
  retraitVertical,
  qualite = null,
  surQualite,
}: {
  c: Couleurs;
  fichier: FichierEnAttente;
  onRetirer: () => void;
  /** Envoi en cours : le retrait est gelé (le fichier est déjà en vol). */
  occupe?: boolean;
  /**
   * Choix de qualité (pastilles Réduite/Originale) — `null` quand il n'y a
   * rien à choisir (audio, document, image légère, ou écran sans réduction).
   * La réduction elle-même se fait à l'ENVOI, chez l'appelant.
   */
  qualite?: QualiteEnvoi | null;
  surQualite?: (qualite: QualiteEnvoi) => void;
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
  const t = useT();
  const enImage = estImage(fichier.type);
  const estAudio = fichier.type.startsWith('audio/');
  const taille = formaterTaille(fichier.taille, t);

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
            <LecteurAudio c={c} url={fichier.uri} titre={t('lecteurAudio.messageVocal')} />
          </View>
          <BoutonRetirer c={c} onRetirer={onRetirer} occupe={occupe} />
        </View>
      ) : (
        <View style={[styles.carte, { backgroundColor: c.carte, borderColor: c.bordure }]}>
          {enImage ? (
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
              {enImage ? t('apercuPieceJointe.image') : fichier.type || t('apercuPieceJointe.fichier')}
              {taille !== null ? ` · ${taille}` : ''}
            </Text>
            {qualite !== null && surQualite !== undefined && (
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
          </View>
          <BoutonRetirer c={c} onRetirer={onRetirer} occupe={occupe} />
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
export function PastilleQualite({
  c,
  quelle,
  choisie,
  occupe,
  surChoisir,
}: {
  c: Couleurs;
  quelle: QualiteEnvoi;
  choisie: boolean;
  occupe: boolean;
  surChoisir: (qualite: QualiteEnvoi) => void;
}) {
  const t = useT();
  return (
    <Pressable
      onPress={() => surChoisir(quelle)}
      disabled={occupe}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ selected: choisie }}
      accessibilityLabel={t(
        quelle === 'reduite'
          ? 'apercuPieceJointe.envoyerReduite'
          : 'apercuPieceJointe.envoyerOriginale',
      )}
      style={[
        styles.pastille,
        {
          borderColor: choisie ? c.accent : c.bordure,
          backgroundColor: choisie ? c.surfaceActive : 'transparent',
          opacity: occupe ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[styles.pastilleTexte, { color: choisie ? c.texte : c.attenue }]}
        numberOfLines={1}
      >
        {t(quelle === 'reduite' ? 'apercuPieceJointe.reduite' : 'apercuPieceJointe.originale')}
      </Text>
    </Pressable>
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
  const t = useT();
  return (
    <Pressable
      onPress={onRetirer}
      disabled={occupe}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('apercuPieceJointe.retirer')}
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
  qualites: { flexDirection: 'row', gap: 6, marginTop: 3 },
  pastille: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  pastilleTexte: { fontFamily: POLICES.corpsSemi, fontSize: 11 },
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
