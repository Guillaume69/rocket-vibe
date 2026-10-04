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
 * carte dédiée (`ui/embedCard.tsx`) — sans quoi le message porterait deux cartes.
 */

import { isWebLink } from './externalLink.ts';
import { isVideoLink, idVideo } from './videoLinks.ts';

export type LinkPreview =
  | { type: 'image'; url: string }
  | {
      type: 'card';
      url: string;
      title: string | null;
      description: string | null;
      /** Vignette (URL publique), ou `null`. */
      image: string | null;
      /** Nom du site (« GitHub »), ou l'hôte en repli. */
      site: string | null;
    };

type UrlEntry = {
  url?: unknown;
  meta?: Record<string, unknown>;
  headers?: { contentType?: unknown };
};

/** Extensions traitées comme image (SVG exclu : `Image` RN ne le rend pas). */
const EXT_IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

const asString = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = decodeEntities(v).trim();
  return t === '' ? null : t;
};

/** Décodage minimal des entités HTML que le serveur laisse parfois dans les métas. */
function decodeEntities(s: string): string {
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

function isImage(entry: UrlEntry, url: string): boolean {
  const ct = typeof entry.headers?.contentType === 'string' ? entry.headers.contentType : '';
  if (ct.startsWith('image/') && !ct.includes('svg')) return true;
  // Repli sur l'extension : le serveur ne peut pas toujours charger l'image
  // (hôte qui bloque son bot) et ne renvoie alors ni headers ni meta.
  const path = url.split(/[?#]/)[0]!;
  return EXT_IMAGE.test(path);
}

function host(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Un premier des candidats non vide, `null` si tous vides. */
function first(meta: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = asString(meta[key]);
    if (v !== null) return v;
  }
  return null;
}

function cardFromMeta(url: string, meta: Record<string, unknown>): LinkPreview | null {
  const title = first(meta, ['ogTitle', 'oembedTitle', 'twitterTitle', 'pageTitle']);
  // La vignette part dans une `<Image>` : un `file://` y ferait lire le disque
  // de l'app, un `data:` y injecterait une image arbitraire. Seul le web.
  const rawImage = first(meta, ['ogImage', 'twitterImage', 'oembedThumbnailUrl']);
  const image = isWebLink(rawImage) ? rawImage : null;
  const description = first(meta, [
    'ogDescription',
    'twitterDescription',
    'description',
    'oembedAuthorName',
  ]);
  const site = first(meta, ['ogSiteName', 'oembedProviderName']) ?? host(url);

  // Sans titre NI image, il n'y a rien à prévisualiser (ex. tweet dont X a
  // bloqué le scraping, ou lien sans balises) : on laisse le lien en texte.
  if (title === null && image === null) return null;
  return { type: 'card', url, title, description, image, site };
}

/** Ce que le serveur sait d'une vidéo, pour la carte embed. */
export type MetaVideo = { title: string | null; author: string | null };

/**
 * Les métas des liens VIDÉO de `urls`, indexées par identifiant de vidéo — le
 * pendant de `apercusDeLien`, qui les saute (la carte embed les rend elle-même).
 * Sans ça la carte n'a que le nom du fournisseur à afficher, alors que le
 * serveur a déjà le titre : YouTube passe par oEmbed (`oembedTitle`,
 * `oembedAuthorName`), les autres par OpenGraph.
 */
export function metasVideo(urlsJson: string | null | undefined): Map<string, MetaVideo> {
  const byId = new Map<string, MetaVideo>();
  let raw: unknown;
  try {
    raw = JSON.parse(urlsJson ?? '');
  } catch {
    return byId;
  }
  if (!Array.isArray(raw)) return byId;

  for (const item of raw) {
    const entry = item as UrlEntry;
    if (typeof entry?.url !== 'string') continue;
    const id = idVideo(entry.url);
    if (id === null || byId.has(id)) continue;
    const meta = entry.meta;
    if (!meta || typeof meta !== 'object') continue;
    const title = first(meta, ['oembedTitle', 'ogTitle', 'twitterTitle', 'pageTitle']);
    const author = first(meta, ['oembedAuthorName', 'ogSiteName']);
    if (title === null && author === null) continue;
    byId.set(id, { title, author });
  }
  return byId;
}

/**
 * Projette `urls` (JSON sérialisé, tel que stocké) en aperçus affichables.
 * Déduplique par URL, saute les liens vidéo (carte dédiée), et plafonne à `max`
 * pour qu'un message truffé de liens ne noie pas le fil.
 */
export function linkPreviews(urlsJson: string | null | undefined, max = 3): LinkPreview[] {
  if (urlsJson === null || urlsJson === undefined || urlsJson === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(urlsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const previews: LinkPreview[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (previews.length >= max) break;
    const entry = item as UrlEntry;
    // Filtré ICI, à la source : ce qui n'est pas du web ne doit ni s'afficher
    // (`file:///…jpg` dans une `<Image>`) ni devenir tapable (`javascript:`,
    // `intent:`). `message.urls` est stocké brut (lib/normalize.ts) et n'a
    // jamais été validé — c'est de la donnée d'autrui.
    const rawUrl = entry?.url;
    const url = isWebLink(rawUrl) ? rawUrl : null;
    if (url === null || seen.has(url)) continue;
    if (isVideoLink(url)) continue; // déjà rendu par la carte vidéo

    let preview: LinkPreview | null = null;
    if (isImage(entry, url)) {
      preview = { type: 'image', url };
    } else if (entry.meta && typeof entry.meta === 'object') {
      preview = cardFromMeta(url, entry.meta);
    }
    if (preview !== null) {
      seen.add(url);
      previews.push(preview);
    }
  }
  return previews;
}
