/**
 * Link previews ("unfurl") from the metadata the SERVER attaches to the
 * message in `urls[]`: OpenGraph, oEmbed, Twitter Cards, parsed by
 * Rocket.Chat. NOTHING is scraped client-side: no network request, no WebView
 * (forbidden, ROADMAP §4.2). We project what the server already collected.
 *
 * Two preview shapes:
 *  - `image`: a link that IS an image (content-type `image/*`, or URL
 *    extension when the server could not load it) → show the image.
 *  - `card`: an article, a video, a tweet… → title + description + thumbnail
 *    + site name, tappable to open the link.
 *
 * Observed on RC 8.5 (`chat.getMessage`):
 *  - reachable image: `{ url, meta:{}, headers:{ contentType:"image/png" } }`
 *  - article        : `meta:{ ogTitle, ogDescription, ogImage, ogSiteName, … }`
 *  - YouTube (oEmbed): `meta:{ oembedTitle, oembedThumbnailUrl, oembedProviderName, oembedHtml }`
 *  - X post: `meta:{}` always, X refuses Rocket.Chat's Googlebot agent (probed
 *    2026-10-14). A Vibez or Mattermost server gets X's og tags; X posts have
 *    their own card either way (`xPostMetas`).
 *  - link without tags (bare page): `meta:{}` → nothing to show.
 *
 * Nothing in `linkPreviews` is provider-specific: only generic
 * OpenGraph/oEmbed fields are read.
 *
 * Video links (YouTube/Dailymotion/Vimeo) and X posts are EXCLUDED: they
 * already have their dedicated card (`ui/embedCard.tsx`, `ui/xPostCard.tsx`),
 * otherwise the message would carry two cards.
 */

import { isWebLink } from './externalLink.ts';
import { isVideoLink, videoId } from './videoLinks.ts';
import { isXPostLink, splitXTitle, xImageKind, xPostId, type XImageKind } from './xPosts.ts';
import {linkPreview} from '../providers/vibez/linkPreviews.ts';

export type LinkPreview =
  | { type: 'image'; url: string }
  | {
      type: 'card';
      url: string;
      title: string | null;
      description: string | null;
      /** Thumbnail (public URL), or `null`. */
      image: string | null;
      /** Site name ("GitHub"), or the host as fallback. */
      site: string | null;
    };

type UrlEntry = {
  native_preview?:unknown;
  native_message?:unknown;
  url?: unknown;
  meta?: Record<string, unknown>;
  headers?: { contentType?: unknown };
};

/** Extensions treated as images (SVG excluded: RN `Image` does not render it). */
const EXT_IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

const asString = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = decodeEntities(v).trim();
  return t === '' ? null : t;
};

/** Minimal decoding of the HTML entities the server sometimes leaves in metas. */
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
  // Fall back on the extension: the server cannot always load the image (host
  // blocking its bot) and then returns neither headers nor meta.
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

/** The first non-empty candidate, `null` if all are empty. */
function first(meta: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = asString(meta[key]);
    if (v !== null) return v;
  }
  return null;
}

function cardFromMeta(url: string, meta: Record<string, unknown>): LinkPreview | null {
  const title = first(meta, ['ogTitle', 'oembedTitle', 'twitterTitle', 'pageTitle']);
  // The thumbnail goes into an `<Image>`: a `file://` would read the app's
  // disk, a `data:` would inject an arbitrary image. Web only.
  const rawImage = first(meta, ['ogImage', 'twitterImage', 'oembedThumbnailUrl']);
  const image = isWebLink(rawImage) ? rawImage : null;
  const description = first(meta, [
    'ogDescription',
    'twitterDescription',
    'description',
    'oembedAuthorName',
  ]);
  const site = first(meta, ['ogSiteName', 'oembedProviderName']) ?? host(url);

  // Without a title OR an image there is nothing to preview (e.g. a tweet whose
  // scraping X blocked, or a link without tags): the link stays as text.
  if (title === null && image === null) return null;
  return { type: 'card', url, title, description, image, site };
}

/** What the server knows about a video, for the embed card. */
export type VideoMeta = { title: string | null; author: string | null; image?:string|null };

/**
 * The metas of the VIDEO links in `urls`, keyed by video id: the counterpart
 * of `linkPreviews`, which skips them (the embed card renders them itself).
 * Without it the card has only the provider name to show, while the server
 * already has the title: YouTube goes through oEmbed (`oembedTitle`,
 * `oembedAuthorName`), the others through OpenGraph.
 */
export function videoMetas(urlsJson: string | null | undefined, native?: (message:string,image:string)=>string|null): Map<string, VideoMeta> {
  const byId = new Map<string, VideoMeta>();
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
    const id = videoId(entry.url);
    if (id === null || byId.has(id)) continue;
    if(entry.native_preview!==undefined){
      try{
        const p=linkPreview(entry.native_preview);
        if(!native||typeof entry.native_message!=='string'||p.url!==entry.url)continue;
        byId.set(id,{title:p.title??null,author:p.site??null,image:p.image?native(entry.native_message,p.image.file_id):null});
      }catch{ /* Malformed native metadata cannot fall back to a public image. */ }
      continue;
    }
    const meta = entry.meta;
    if (!meta || typeof meta !== 'object') continue;
    const title = first(meta, ['oembedTitle', 'ogTitle', 'twitterTitle', 'pageTitle']);
    const author = first(meta, ['oembedAuthorName', 'ogSiteName']);
    if (title === null && author === null) continue;
    byId.set(id, { title, author });
  }
  return byId;
}

/** What the server knows about an X post, for its card. */
export type XPostMeta = {
  /** The author's display name. */
  name: string | null;
  handle: string | null;
  /** The post's text. */
  text: string | null;
  /** Its picture, a video's first image, or the author's photo (`imageKind`). */
  image: string | null;
  imageKind: XImageKind | null;
};

/**
 * The metas of the X post links in `urls`, keyed by post id: the counterpart
 * of `linkPreviews`, which skips them. X serves ordinary OpenGraph tags
 * (probed 2026-10-14): `ogTitle` "<name> (@<handle>) on X", `ogDescription`
 * the text, `ogImage` the first picture, a video's first image, or for a
 * post without media the author's photo, told apart by its path. A Vibez
 * server drops that photo (`apps/server/src/link_previews/network.rs`) and
 * keeps the rest as a private PNG.
 */
export function xPostMetas(urlsJson: string | null | undefined, native?: (message:string,image:string)=>string|null): Map<string, XPostMeta> {
  const byId = new Map<string, XPostMeta>();
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
    const id = xPostId(entry.url);
    if (id === null || byId.has(id)) continue;
    let title: string | null, text: string | null, image: string | null, kind: XImageKind | null;
    if (entry.native_preview !== undefined) {
      try {
        const p = linkPreview(entry.native_preview);
        if (!native || typeof entry.native_message !== 'string' || p.url !== entry.url) continue;
        title = asString(p.title);
        text = asString(p.description);
        image = p.image ? native(entry.native_message, p.image.file_id) : null;
        kind = image === null ? null : 'photo';
      } catch {
        continue; // Malformed native metadata cannot fall back to a public image.
      }
    } else {
      const meta = entry.meta;
      if (!meta || typeof meta !== 'object') continue;
      title = first(meta, ['ogTitle', 'twitterTitle']);
      text = first(meta, ['ogDescription', 'twitterDescription']);
      const rawImage = first(meta, ['ogImage', 'twitterImage']);
      image = isWebLink(rawImage) ? rawImage : null;
      kind = image === null ? null : xImageKind(image);
    }
    if (title === null && text === null && image === null) continue;
    const split = title === null ? null : splitXTitle(title);
    byId.set(id, { name: split?.name ?? null, handle: split?.handle ?? null, text, image, imageKind: kind });
  }
  return byId;
}

/**
 * Projects `urls` (serialized JSON, as stored) into displayable previews.
 * Dedupes by URL, skips video links and X posts (dedicated cards), and caps at `max` so a
 * message stuffed with links does not drown the timeline.
 */
export function linkPreviews(urlsJson: string | null | undefined, max = 3, native?: (message:string,image:string)=>string|null): LinkPreview[] {
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
    // Filtered HERE, at the source: anything that is not web must neither
    // display (`file:///…jpg` in an `<Image>`) nor become tappable
    // (`javascript:`, `intent:`). `message.urls` is stored raw
    // (lib/normalize.ts) and never validated: it is someone else's data.
    const rawUrl = entry?.url;
    const url = isWebLink(rawUrl) ? rawUrl : null;
    if (url === null || seen.has(url)) continue;
    if (isVideoLink(url) || isXPostLink(url)) continue; // rendered by their own card

    if(entry.native_preview!==undefined){
      try{
        const p=linkPreview(entry.native_preview);
        if(!native||typeof entry.native_message!=='string'||p.url!==url)continue;
        const image=p.image?native(entry.native_message,p.image.file_id):null;
        if(p.kind==='image'){if(image)previews.push({type:'image',url:image});}
        else previews.push({type:'card',url:p.url,title:p.title??null,description:p.description??null,image,site:p.site??null});
        seen.add(url);
      }catch{ /* Reject a malformed native manifest without a public-image fallback. */ }
      continue;
    }

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
