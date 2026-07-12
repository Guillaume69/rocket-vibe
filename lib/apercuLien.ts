/**
 * Aperçus de lien (« unfurl ») à partir des métadonnées que le SERVEUR attache
 * au message dans `urls[]` — OpenGraph, oEmbed, Twitter Cards, parsés côté
 * Rocket.Chat. On ne scrape RIEN côté client : ni requête réseau, ni WebView
 * (interdite, ROADMAP §4.2). On projette ce que le serveur a déjà récolté.
 *
 * Deux formes d'aperçu :
 *  - `image` : un lien qui EST une image (content-type `image/*`, ou extension
 *    d'URL quand le serveur n'a pas pu la charger) → on affiche l'image.
 *  - `carte` : un article, une vidéo, un tweet… → titre + description + vignette
 *    + nom du site, tapable pour ouvrir le lien.
 *
 * Relevé sur RC 8.5 (`chat.getMessage`) :
 *  - image joignable : `{ url, meta:{}, headers:{ contentType:"image/png" } }`
 *  - article        : `meta:{ ogTitle, ogDescription, ogImage, ogSiteName, … }`
 *  - YouTube (oEmbed): `meta:{ oembedTitle, oembedThumbnailUrl, oembedProviderName, oembedHtml }`
 *  - tweet vivant (x.com ou twitter.com) : balises og normales →
 *    `meta:{ ogTitle:"… (@…) on X", ogDescription:<texte>, ogImage:<média>, ogSiteName:"X (formerly Twitter)" }`
 *    → carte avec l'image ET le texte, comme n'importe quel article.
 *  - lien sans balises (tweet supprimé, page nue) : `meta:{}` → rien à montrer.
 *
 * Rien ici n'est spécifique à un fournisseur : on ne lit que des champs
 * OpenGraph/oEmbed génériques. « Ça marche pour Twitter » n'est qu'un cas de
 * « ça marche pour toute URL que le serveur sait décrire ».
 *
 * Les liens vidéo (YouTube/Dailymotion/Vimeo) sont EXCLUS : ils ont déjà leur
 * carte dédiée (`ui/carteEmbed.tsx`) — sans quoi le message porterait deux cartes.
 */

import { estLienVideo } from './liensVideo.ts';

export type ApercuLien =
  | { type: 'image'; url: string }
  | {
      type: 'carte';
      url: string;
      titre: string | null;
      description: string | null;
      /** Vignette (URL publique), ou `null`. */
      image: string | null;
      /** Nom du site (« GitHub »), ou l'hôte en repli. */
      site: string | null;
    };

type EntreeUrl = {
  url?: unknown;
  meta?: Record<string, unknown>;
  headers?: { contentType?: unknown };
};

/** Extensions traitées comme image (SVG exclu : `Image` RN ne le rend pas). */
const EXT_IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

const chaine = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = decoderEntites(v).trim();
  return t === '' ? null : t;
};

/** Décodage minimal des entités HTML que le serveur laisse parfois dans les métas. */
function decoderEntites(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

function estImage(entree: EntreeUrl, url: string): boolean {
  const ct = typeof entree.headers?.contentType === 'string' ? entree.headers.contentType : '';
  if (ct.startsWith('image/') && !ct.includes('svg')) return true;
  // Repli sur l'extension : le serveur ne peut pas toujours charger l'image
  // (hôte qui bloque son bot) et ne renvoie alors ni headers ni meta.
  const chemin = url.split(/[?#]/)[0]!;
  return EXT_IMAGE.test(chemin);
}

function hote(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Un premier des candidats non vide, `null` si tous vides. */
function premier(meta: Record<string, unknown>, cles: readonly string[]): string | null {
  for (const cle of cles) {
    const v = chaine(meta[cle]);
    if (v !== null) return v;
  }
  return null;
}

function carteDepuisMeta(url: string, meta: Record<string, unknown>): ApercuLien | null {
  const titre = premier(meta, ['ogTitle', 'oembedTitle', 'twitterTitle', 'pageTitle']);
  const image = premier(meta, ['ogImage', 'twitterImage', 'oembedThumbnailUrl']);
  const description = premier(meta, [
    'ogDescription',
    'twitterDescription',
    'description',
    'oembedAuthorName',
  ]);
  const site = premier(meta, ['ogSiteName', 'oembedProviderName']) ?? hote(url);

  // Sans titre NI image, il n'y a rien à prévisualiser (ex. tweet dont X a
  // bloqué le scraping, ou lien sans balises) : on laisse le lien en texte.
  if (titre === null && image === null) return null;
  return { type: 'carte', url, titre, description, image, site };
}

/**
 * Projette `urls` (JSON sérialisé, tel que stocké) en aperçus affichables.
 * Déduplique par URL, saute les liens vidéo (carte dédiée), et plafonne à `max`
 * pour qu'un message truffé de liens ne noie pas le fil.
 */
export function apercusDeLien(urlsJson: string | null | undefined, max = 3): ApercuLien[] {
  if (urlsJson === null || urlsJson === undefined || urlsJson === '') return [];
  let brut: unknown;
  try {
    brut = JSON.parse(urlsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(brut)) return [];

  const apercus: ApercuLien[] = [];
  const vus = new Set<string>();

  for (const item of brut) {
    if (apercus.length >= max) break;
    const entree = item as EntreeUrl;
    const url = typeof entree?.url === 'string' ? entree.url : null;
    if (url === null || vus.has(url)) continue;
    if (estLienVideo(url)) continue; // déjà rendu par la carte vidéo

    let apercu: ApercuLien | null = null;
    if (estImage(entree, url)) {
      apercu = { type: 'image', url };
    } else if (entree.meta && typeof entree.meta === 'object') {
      apercu = carteDepuisMeta(url, entree.meta);
    }
    if (apercu !== null) {
      vus.add(url);
      apercus.push(apercu);
    }
  }
  return apercus;
}
