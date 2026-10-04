/**
 * Aperçus de lien dans le fil : image directe, ou carte « unfurl »
 * (titre/description/vignette/site) à partir des métadonnées serveur
 * (`lib/linkPreview.ts`). Aucune WebView, aucun scraping — on projette ce que
 * Rocket.Chat a déjà parsé dans `message.urls`.
 *
 * L'image d'un aperçu est une URL PUBLIQUE (og:image, vignette oEmbed, ou lien
 * image direct) : `Image` simple, sans `rc_uid`/`rc_token` — contrairement aux
 * pièces jointes, qui sont des fichiers protégés du serveur.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { linkPreviews, type LinkPreview } from '../lib/linkPreview.ts';
import { useT } from './i18n.ts';
import { openExternalLink } from './externalLink.ts';
import { type Colors, availableBodyWidth, FONTS } from './theme.ts';
import { useImageViewer } from './imageViewer.tsx';

/** Rend un aperçu par lien exploitable dans `urls` (rien si aucun). */
export function LinkPreviews({
  c,
  urls,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  urls: string | null;
  onLongPress?: (() => void) | undefined;
}) {
  const { width: largeurEcran } = useWindowDimensions();
  const apercus = useMemo(() => linkPreviews(urls), [urls]);
  if (apercus.length === 0) return null;

  // Même largeur disponible que les images jointes — voir `largeurDispoCorps`.
  const largeurDispo = availableBodyWidth(largeurEcran);

  return (
    <View style={styles.list}>
      {apercus.map((apercu, i) =>
        apercu.type === 'image' ? (
          <ApercuImage
            key={apercu.url + i}
            c={c}
            url={apercu.url}
            availableWidth={largeurDispo}
            onLongPress={surAppuiLong}
          />
        ) : (
          <ApercuCarte
            key={apercu.url + i}
            c={c}
            preview={apercu}
            availableWidth={largeurDispo}
            onLongPress={surAppuiLong}
          />
        ),
      )}
    </View>
  );
}

/** Un lien qui EST une image : affichée, tapable pour agrandir. */
function ApercuImage({
  c,
  url,
  availableWidth: largeurDispo,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  url: string;
  availableWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const visionneuse = useImageViewer();
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    setDims(null);
    setErreur(false);
    Image.getSize(
      url,
      (w, h) => {
        if (vivant) setDims({ w, h });
      },
      () => {
        if (vivant) setErreur(true);
      },
    );
    return () => {
      vivant = false;
    };
  }, [url]);

  // Un lien image cassé (404, hôte injoignable) ne laisse rien s'afficher.
  if (erreur) return null;

  // Pas d'agrandissement au-delà de la taille native ; plancher pour rester
  // tapable. Ratio par défaut le temps de connaître les dimensions réelles.
  const largeur = Math.max(Math.min(dims?.w ?? largeurDispo, largeurDispo), 120);
  const ratio = dims ? dims.h / Math.max(dims.w, 1) : 0.66;
  const hauteur = Math.min(Math.round(largeur * ratio), 400);

  return (
    <Pressable
      onPress={() =>
        visionneuse.open({ uri: url, width: dims?.w ?? null, height: dims?.h ?? null, title: null })
      }
      onLongPress={surAppuiLong}
      delayLongPress={350}
      accessibilityRole="imagebutton"
      accessibilityLabel={t('carteLien.imageAgrandir')}
      style={{ width: largeur, height: hauteur }}
    >
      {dims === null ? (
        <View
          style={[
            styles.imageAttente,
            { width: largeur, height: hauteur, backgroundColor: c.pendingImageBackground },
          ]}
        >
          <ActivityIndicator />
        </View>
      ) : (
        <Image
          source={{ uri: url }}
          style={[
            styles.image,
            { width: largeur, height: hauteur, backgroundColor: c.pendingImageBackground },
          ]}
          resizeMode="cover"
          onError={() => setErreur(true)}
        />
      )}
    </Pressable>
  );
}

/** Carte « unfurl » : bandeau optionnel + site + titre + description. */
function ApercuCarte({
  c,
  preview: apercu,
  availableWidth: largeurDispo,
  onLongPress: surAppuiLong,
}: {
  c: Colors;
  preview: Extract<LinkPreview, { type: 'carte' }>;
  availableWidth: number;
  onLongPress: (() => void) | undefined;
}) {
  const t = useT();
  const [erreurImage, setErreurImage] = useState(false);
  const montreBandeau = apercu.image !== null && !erreurImage;
  const nomAccessible = apercu.title ?? apercu.site ?? t('carteLien.lienDefaut');

  return (
    <Pressable
      onPress={() => openExternalLink(apercu.url)}
      onLongPress={surAppuiLong}
      delayLongPress={350}
      accessibilityRole="link"
      accessibilityLabel={t('carteLien.ouvrir', { nom: nomAccessible })}
      style={[styles.card, { width: largeurDispo, backgroundColor: c.card, borderColor: c.border }]}
    >
      {montreBandeau && (
        <Image
          source={{ uri: apercu.image! }}
          style={[styles.banner, { backgroundColor: c.pendingImageBackground }]}
          resizeMode="cover"
          onError={() => setErreurImage(true)}
        />
      )}
      <View style={styles.texteCarte}>
        {apercu.site !== null && (
          <Text style={[styles.site, { color: c.cyan }]} numberOfLines={1}>
            {apercu.site}
          </Text>
        )}
        {apercu.title !== null && (
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {apercu.title}
          </Text>
        )}
        {apercu.description !== null && (
          <Text style={[styles.description, { color: c.secondaryText }]} numberOfLines={2}>
            {apercu.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 4 },
  // Les fonds d'attente (`fondImageAttente`) viennent du thème, posés au rendu.
  image: { borderRadius: 10 },
  imageAttente: {
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  banner: {
    width: '100%',
    aspectRatio: 1.91, // ratio OpenGraph standard
  },
  texteCarte: { paddingHorizontal: 12, paddingVertical: 10, gap: 3 },
  site: { fontFamily: FONTS.corpsSemi, fontSize: 11, letterSpacing: 0.3 },
  title: { fontFamily: FONTS.corpsFort, fontSize: 13.5, lineHeight: 18 },
  description: { fontFamily: FONTS.body, fontSize: 12.5, lineHeight: 17 },
});
