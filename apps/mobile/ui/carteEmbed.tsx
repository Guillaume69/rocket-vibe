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
 * Les vignettes Rocket.Chat restent publiques. RocketVibe utilise l'image
 * privée du message, via le même lecteur que les cartes d'article. Sans image
 * disponible, la bannière dégradée « aurore » reste le repli existant.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { metasVideo, type MetaVideo } from '../lib/apercuLien.ts';
import type {ClientRest} from '../lib/rest.ts';
import {uriApercuNatif} from '../lib/apercusNatifs.ts';
import {useApercuNatif} from './apercuNatif.ts';
import { detecterLiensVideo, type LienVideo } from '../lib/liensVideo.ts';
import { useT } from './i18n.ts';
import { ouvrirLienExterne } from './lienExterne.ts';
import { type Couleurs, POLICES } from './theme.ts';

/** Rend une carte par lien vidéo détecté dans `texte` (rien si aucun). */
export function LiensEmbed({
  c,
  texte,
  urls,
  client,
  surAppuiLong,
}: {
  c: Couleurs;
  texte: string | null;
  /** `message.urls` : le titre de la vidéo s'y trouve, récolté par le serveur. */
  urls: string | null;
  client?:ClientRest;
  surAppuiLong?: (() => void) | undefined;
}) {
  const liens = useMemo(() => detecterLiensVideo(texte), [texte]);
  const metas = useMemo(() => metasVideo(urls,client?.genre==='rocketvibe'?(message,image)=>uriApercuNatif(client,message,image):undefined), [urls,client]);
  if (liens.length === 0) return null;
  return (
    <View style={styles.liste}>
      {liens.map((lien, i) => (
        <CarteEmbed
          key={`${lien.provider}:${lien.id}:${i}`}
          c={c}
          lien={lien}
          meta={metas.get(lien.id) ?? null}
          native={client?.genre==='rocketvibe'}
          surAppuiLong={surAppuiLong}
        />
      ))}
    </View>
  );
}

function CarteEmbed({
  c,
  lien,
  meta,
  native,
  surAppuiLong,
}: {
  c: Couleurs;
  lien: LienVideo;
  /** `null` tant que le serveur n'a pas (encore) décrit le lien. */
  meta: MetaVideo | null;
  native:boolean;
  surAppuiLong?: (() => void) | undefined;
}) {
  const t = useT();
  const [erreurVignette, setErreurVignette] = useState<string|null>(null);
  const image=useApercuNatif(native?meta?.image??null:lien.vignette);
  const montreVignette = !!image && erreurVignette!==image;

  const titre = meta?.titre ?? null;

  return (
    <Pressable
      onPress={() => ouvrirLienExterne(lien.url)}
      onLongPress={surAppuiLong}
      delayLongPress={350}
      style={[styles.carte, { borderColor: c.bordure, backgroundColor: c.fondImageAttente }]}
      accessibilityRole="button"
      accessibilityLabel={t('carteEmbed.ouvrir', { nom: titre ?? lien.nom })}
    >
      <View style={styles.media}>
      {montreVignette ? (
        <Image
          source={{ uri: image! }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setErreurVignette(image??null)}
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
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.voileMediaLeger }]} />

      <LinearGradient
        colors={c.degradeCta}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bouton}
      >
        {/* Triangle DESSINÉ, pas un emoji (« ▶ » sort orange sur Android). */}
        <View style={[styles.iconePlay, { borderLeftColor: c.surAccent }]} />
      </LinearGradient>
      </View>

      <View style={[styles.pied, { backgroundColor: c.carte }]}>
        {titre !== null && (
          <Text style={[styles.titre, { color: c.texte }]} numberOfLines={2}>
            {titre}
          </Text>
        )}
        <View style={styles.ligneSource}>
          <View style={[styles.triangleMini, { borderLeftColor: c.texteTertiaire }]} />
          <Text style={[styles.nom, { color: c.texteTertiaire }]} numberOfLines={1}>
            {meta?.auteur != null ? `${lien.nom} · ${meta.auteur}` : lien.nom}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  liste: { gap: 6, marginTop: 4 },
  // Les couleurs (`fondImageAttente`, `voileMediaLeger`) viennent du thème.
  carte: {
    width: 240,
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  media: { aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' },
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
  pied: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  ligneSource: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titre: { fontFamily: POLICES.corpsSemi, fontSize: 13, lineHeight: 17 },
  triangleMini: {
    width: 0,
    height: 0,
    borderTopWidth: 4,
    borderBottomWidth: 4,
    borderLeftWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  nom: { fontFamily: POLICES.corps, fontSize: 11, flexShrink: 1 },
});
