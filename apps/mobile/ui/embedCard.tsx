/**
 * Carte d'aperçu pour un lien vidéo « embed » (YouTube, Dailymotion, Vimeo).
 *
 * La lecture vraiment intégrée exigerait une WebView (interdite hors de
 * l'écran d'appel, ROADMAP §4.2) :
 * on montre donc une carte dans le même langage que la carte vidéo locale —
 * vignette publique en bannière, voile sombre, bouton de lecture dégradé, et un
 * pied qui porte le titre de la vidéo et sa chaîne quand le serveur les a
 * récoltés (`metasVideo`) — un toucher OUVRE l'appli native
 * (YouTube/Dailymotion) ou le navigateur via `Linking`. Pas de WebView, pas de
 * flux à extraire.
 *
 * La vignette est une URL PUBLIQUE (pas un fichier protégé Rocket.Chat) : `Image`
 * simple, sans `rc_uid`/`rc_token`. Si elle manque (Vimeo, ou 404), on retombe
 * sur la bannière dégradée « aurore ».
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { metasVideo, type MetaVideo } from '../lib/linkPreview.ts';
import { detectVideoLinks, type VideoLink } from '../lib/videoLinks.ts';
import { useT } from './i18n.ts';
import { openExternalLink } from './externalLink.ts';
import { type Colors, FONTS } from './theme.ts';

/** Rend une carte par lien vidéo détecté dans `texte` (rien si aucun). */
export function EmbedLinks({
  c,
  text: texte,
  urls,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  text: string | null;
  /** `message.urls` : le titre de la vidéo s'y trouve, récolté par le serveur. */
  urls: string | null;
  onLongPress?: (() => void) | undefined;
}) {
  const liens = useMemo(() => detectVideoLinks(texte), [texte]);
  const metas = useMemo(() => metasVideo(urls), [urls]);
  if (liens.length === 0) return null;
  return (
    <View style={styles.list}>
      {liens.map((lien, i) => (
        <CarteEmbed
          key={`${lien.provider}:${lien.id}:${i}`}
          c={c}
          link={lien}
          meta={metas.get(lien.id) ?? null}
          onLongPress={surAppuiLong}
        />
      ))}
    </View>
  );
}

function CarteEmbed({
  c,
  link: lien,
  meta,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  link: VideoLink;
  /** `null` tant que le serveur n'a pas (encore) décrit le lien. */
  meta: MetaVideo | null;
  onLongPress?: (() => void) | undefined;
}) {
  const t = useT();
  const [erreurVignette, setErreurVignette] = useState(false);
  const montreVignette = lien.thumbnail !== null && !erreurVignette;

  const titre = meta?.title ?? null;

  return (
    <Pressable
      onPress={() => openExternalLink(lien.url)}
      onLongPress={surAppuiLong}
      delayLongPress={350}
      style={[styles.card, { borderColor: c.border, backgroundColor: c.pendingImageBackground }]}
      accessibilityRole="button"
      accessibilityLabel={t('carteEmbed.ouvrir', { nom: titre ?? lien.name })}
    >
      <View style={styles.media}>
      {montreVignette ? (
        <Image
          source={{ uri: lien.thumbnail! }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setErreurVignette(true)}
        />
      ) : (
        <LinearGradient
          colors={c.brandGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {/* Voile : contraste pour que le bouton et l'étiquette ressortent sur
          n'importe quelle vignette. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.lightMediaScrim }]} />

      <LinearGradient
        colors={c.ctaGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.button}
      >
        {/* Triangle DESSINÉ, pas un emoji (« ▶ » sort orange sur Android). */}
        <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
      </LinearGradient>
      </View>

      <View style={[styles.footer, { backgroundColor: c.card }]}>
        {titre !== null && (
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {titre}
          </Text>
        )}
        <View style={styles.ligneSource}>
          <View style={[styles.triangleMini, { borderLeftColor: c.tertiaryText }]} />
          <Text style={[styles.name, { color: c.tertiaryText }]} numberOfLines={1}>
            {meta?.author != null ? `${lien.name} · ${meta.author}` : lien.name}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  // Les couleurs (`fondImageAttente`, `voileMediaLeger`) viennent du thème.
  card: {
    width: 240,
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  media: { aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' },
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
  footer: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  ligneSource: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: FONTS.corpsSemi, fontSize: 13, lineHeight: 17 },
  triangleMini: {
    width: 0,
    height: 0,
    borderTopWidth: 4,
    borderBottomWidth: 4,
    borderLeftWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  name: { fontFamily: FONTS.body, fontSize: 11, flexShrink: 1 },
});
