/**
 * Aperçus de lien dans le fil : image directe, ou carte « unfurl »
 * (titre/description/vignette/site) à partir des métadonnées serveur
 * (`lib/apercuLien.ts`). Aucune WebView, aucun scraping — on projette ce que
 * le fournisseur a déjà projeté dans `message.urls`.
 *
 * Les images Rocket.Chat restent publiques ; les aperçus RocketVibe passent
 * par le lecteur privé lié au message, y compris dans la visionneuse.
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

import { apercusDeLien, type ApercuLien } from '../lib/apercuLien.ts';
import type {ClientRest} from '../lib/rest.ts';
import {uriApercuNatif} from '../lib/apercusNatifs.ts';
import {useApercuNatif} from './apercuNatif.ts';
import { useT } from './i18n.ts';
import { ouvrirLienExterne } from './lienExterne.ts';
import { type Couleurs, largeurDispoCorps, POLICES } from './theme.ts';
import { useVisionneuse } from './visionneuse.tsx';

/** Rend un aperçu par lien exploitable dans `urls` (rien si aucun). */
export function ApercusLien({
  c,
  urls,
  client,
  surAppuiLong,
}: {
  c: Couleurs;
  urls: string | null;
  client?:ClientRest;
  surAppuiLong?: (() => void) | undefined;
}) {
  const { width: largeurEcran } = useWindowDimensions();
  const apercus = useMemo(() => apercusDeLien(urls,3,client?.genre==='rocketvibe'?(message,image)=>uriApercuNatif(client,message,image):undefined), [urls,client]);
  if (apercus.length === 0) return null;

  // Même largeur disponible que les images jointes — voir `largeurDispoCorps`.
  const largeurDispo = largeurDispoCorps(largeurEcran);

  return (
    <View style={styles.liste}>
      {apercus.map((apercu, i) =>
        apercu.type === 'image' ? (
          <ApercuImage
            key={apercu.url + i}
            c={c}
            url={apercu.url}
            largeurDispo={largeurDispo}
            surAppuiLong={surAppuiLong}
          />
        ) : (
          <ApercuCarte
            key={apercu.url + i}
            c={c}
            apercu={apercu}
            largeurDispo={largeurDispo}
            surAppuiLong={surAppuiLong}
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
  largeurDispo,
  surAppuiLong,
}: {
  c: Couleurs;
  url: string;
  largeurDispo: number;
  surAppuiLong: (() => void) | undefined;
}) {
  const t = useT();
  const visionneuse = useVisionneuse();
  const [mesure, setMesure] = useState<{ uri:string; w: number; h: number } | null>(null);
  const [erreur, setErreur] = useState<string|null>(null);
  const local=useApercuNatif(url),native=url.startsWith('rv-preview:');
  const dims=mesure?.uri===local?mesure:null;

  useEffect(() => {
    let vivant = true;
    if(!local)return()=>{vivant=false;};
    Image.getSize(
      local,
      (w, h) => {
        if (vivant) setMesure({ uri:local,w, h });
      },
      () => {
        if (vivant) setErreur(local);
      },
    );
    return () => {
      vivant = false;
    };
  }, [local]);

  // Un lien image cassé (404, hôte injoignable) ne laisse rien s'afficher.
  if (erreur===local || native&&!local) return null;

  // Pas d'agrandissement au-delà de la taille native ; plancher pour rester
  // tapable. Ratio par défaut le temps de connaître les dimensions réelles.
  const largeur = Math.max(Math.min(dims?.w ?? largeurDispo, largeurDispo), 120);
  const ratio = dims ? dims.h / Math.max(dims.w, 1) : 0.66;
  const hauteur = Math.min(Math.round(largeur * ratio), 400);

  return (
    <Pressable
      onPress={() =>
        local&&visionneuse.ouvrir({ uri: native?url:local, largeur: dims?.w ?? null, hauteur: dims?.h ?? null, titre: null,type:native?'image/png':null })
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
            { width: largeur, height: hauteur, backgroundColor: c.fondImageAttente },
          ]}
        >
          <ActivityIndicator />
        </View>
      ) : (
        <Image
          source={local?{ uri: local }:undefined}
          style={[
            styles.image,
            { width: largeur, height: hauteur, backgroundColor: c.fondImageAttente },
          ]}
          resizeMode="cover"
          onError={() => setErreur(local??null)}
        />
      )}
    </Pressable>
  );
}

/** Carte « unfurl » : bandeau optionnel + site + titre + description. */
function ApercuCarte({
  c,
  apercu,
  largeurDispo,
  surAppuiLong,
}: {
  c: Couleurs;
  apercu: Extract<ApercuLien, { type: 'carte' }>;
  largeurDispo: number;
  surAppuiLong: (() => void) | undefined;
}) {
  const t = useT();
  const [erreurImage, setErreurImage] = useState<string|null>(null);
  const local=useApercuNatif(apercu.image);
  const montreBandeau = !!local && erreurImage!==local;
  const nomAccessible = apercu.titre ?? apercu.site ?? t('carteLien.lienDefaut');

  return (
    <Pressable
      onPress={() => ouvrirLienExterne(apercu.url)}
      onLongPress={surAppuiLong}
      delayLongPress={350}
      accessibilityRole="link"
      accessibilityLabel={t('carteLien.ouvrir', { nom: nomAccessible })}
      style={[styles.carte, { width: largeurDispo, backgroundColor: c.carte, borderColor: c.bordure }]}
    >
      {montreBandeau && (
        <Image
          source={{ uri: local! }}
          style={[styles.bandeau, { backgroundColor: c.fondImageAttente }]}
          resizeMode="cover"
            onError={() => setErreurImage(local??null)}
        />
      )}
      <View style={styles.texteCarte}>
        {apercu.site !== null && (
          <Text style={[styles.site, { color: c.cyan }]} numberOfLines={1}>
            {apercu.site}
          </Text>
        )}
        {apercu.titre !== null && (
          <Text style={[styles.titre, { color: c.texte }]} numberOfLines={2}>
            {apercu.titre}
          </Text>
        )}
        {apercu.description !== null && (
          <Text style={[styles.description, { color: c.texteSecondaire }]} numberOfLines={2}>
            {apercu.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  liste: { gap: 6, marginTop: 4 },
  // Les fonds d'attente (`fondImageAttente`) viennent du thème, posés au rendu.
  image: { borderRadius: 10 },
  imageAttente: {
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  carte: {
    maxWidth: '100%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  bandeau: {
    width: '100%',
    aspectRatio: 1.91, // ratio OpenGraph standard
  },
  texteCarte: { paddingHorizontal: 12, paddingVertical: 10, gap: 3 },
  site: { fontFamily: POLICES.corpsSemi, fontSize: 11, letterSpacing: 0.3 },
  titre: { fontFamily: POLICES.corpsFort, fontSize: 13.5, lineHeight: 18 },
  description: { fontFamily: POLICES.corps, fontSize: 12.5, lineHeight: 17 },
});
