/**
 * Carte d'aperçu pour un lien vidéo « embed » (YouTube, Dailymotion, Vimeo).
 *
 * La lecture vraiment intégrée exigerait une WebView (interdite, ROADMAP §4.2) :
 * on montre donc une carte dans le même langage que la carte vidéo locale —
 * vignette publique en bannière, voile sombre, bouton de lecture dégradé — et
 * un toucher OUVRE l'appli native (YouTube/Dailymotion) ou le navigateur via
 * `Linking`. Pas de WebView, pas de flux à extraire.
 *
 * La vignette est une URL PUBLIQUE (pas un fichier protégé Rocket.Chat) : `Image`
 * simple, sans `rc_uid`/`rc_token`. Si elle manque (Vimeo, ou 404), on retombe
 * sur la bannière dégradée « aurore ».
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { detecterLiensVideo, type LienVideo } from '../lib/liensVideo.ts';
import { useT } from './i18n.ts';
import { type Couleurs, POLICES } from './theme.ts';

/** Rend une carte par lien vidéo détecté dans `texte` (rien si aucun). */
export function LiensEmbed({
  c,
  texte,
  surAppuiLong,
}: {
  c: Couleurs;
  texte: string | null;
  surAppuiLong?: (() => void) | undefined;
}) {
  const liens = useMemo(() => detecterLiensVideo(texte), [texte]);
  if (liens.length === 0) return null;
  return (
    <View style={styles.liste}>
      {liens.map((lien, i) => (
        <CarteEmbed key={`${lien.provider}:${lien.id}:${i}`} c={c} lien={lien} surAppuiLong={surAppuiLong} />
      ))}
    </View>
  );
}

function CarteEmbed({
  c,
  lien,
  surAppuiLong,
}: {
  c: Couleurs;
  lien: LienVideo;
  surAppuiLong?: (() => void) | undefined;
}) {
  const t = useT();
  const [erreurVignette, setErreurVignette] = useState(false);
  const montreVignette = lien.vignette !== null && !erreurVignette;

  return (
    <Pressable
      onPress={() => void Linking.openURL(lien.url).catch(() => {})}
      onLongPress={surAppuiLong}
      delayLongPress={350}
      style={[styles.carte, { borderColor: c.bordure }]}
      accessibilityRole="button"
      accessibilityLabel={t('carteEmbed.ouvrir', { nom: lien.nom })}
    >
      {montreVignette ? (
        <Image
          source={{ uri: lien.vignette! }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setErreurVignette(true)}
        />
      ) : (
        <LinearGradient
          colors={c.degradeMarque}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {/* Voile : contraste pour que le bouton et l'étiquette ressortent sur
          n'importe quelle vignette. */}
      <View style={[StyleSheet.absoluteFill, styles.voile]} />

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
        <View style={[styles.triangleMini, { borderLeftColor: c.texte }]} />
        <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1}>
          {lien.nom}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  liste: { gap: 6, marginTop: 4 },
  carte: {
    width: 240,
    maxWidth: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000020',
  },
  voile: { backgroundColor: 'rgba(12,11,22,0.42)' },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  triangleMini: {
    width: 0,
    height: 0,
    borderTopWidth: 4,
    borderBottomWidth: 4,
    borderLeftWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  nom: { fontFamily: POLICES.corpsSemi, fontSize: 12, flexShrink: 1 },
});
