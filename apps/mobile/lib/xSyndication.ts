/**
 * An X post read from X itself, for Rocket.Chat accounts only.
 *
 * Rocket.Chat 8.5 fetches X posts with a Googlebot user agent that X refuses,
 * so their `urls` never carry anything (CLAUDE.md, "Rocket.Chat facts"). On
 * such an account the card asks X's syndication endpoint, the one X's own
 * embed widget reads (`cdn.syndication.twimg.com/tweet-result`), for the post
 * it shows: the device then tells X which post was linked. A Vibez or
 * Mattermost server collects the post itself, and the app asks nothing
 * (user decision, 2026-10-14; brain/features/x-posts.md).
 */

import type { XPostMeta } from './linkPreview.ts';

const ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';
/** Bounded so a long session does not keep every post it ever showed. */
const MAX_CACHED = 300;
const TIMEOUT_MS = 15_000;

/**
 * The `token` X's widget sends with the id. Its value is not checked today
 * (any non-empty token answers, none gets `{}`; probed 2026-10-14), but this
 * is the widget's own formula, so the request stays the widget's.
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

type Json = Record<string, unknown>;
const record = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const webUrl = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && /^https:\/\//.test(s) ? s : null;
};

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** `[start, end)` of a JSON pair of code-point indices. */
function span(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number' || v[0] > v[1]) return null;
  return [v[0], v[1]];
}

/**
 * The post's text as X shows it, counted in code points of the decoded text:
 * the `display_text_range` slice (it drops leading @replies), without the
 * media's own `t.co` link (`mediaDetails[].indices`, which older posts keep
 * inside the range), and other `t.co` links in their display form.
 */
function displayText(post: Json): string | null {
  const escaped = str(post.text);
  if (escaped === null) return null;
  // X counts its indices on the decoded text: `&amp;` is one character.
  const points = Array.from(decodeEntities(escaped));
  const [start, end] = span(post.display_text_range) ?? [0, points.length];
  const media = (Array.isArray(post.mediaDetails) ? post.mediaDetails : [])
    .map((m) => span(record(m)?.indices))
    .filter((r): r is [number, number] => r !== null);
  let text = points
    .filter((_, i) => i >= start && i < end && !media.some(([a, b]) => i >= a && i < b))
    .join('');
  const urls = record(post.entities)?.urls;
  if (Array.isArray(urls)) {
    for (const u of urls) {
      const short = str(record(u)?.url);
      const shown = str(record(u)?.display_url) ?? str(record(u)?.expanded_url);
      if (short !== null && shown !== null) text = text.split(short).join(shown);
    }
  }
  const out = text.trim();
  return out === '' ? null : out;
}

/** The card's fields from a `tweet-result` answer, `null` if it is not a post. */
export function parseSyndication(json: unknown): XPostMeta | null {
  const post = record(json);
  if (post === null || post.__typename !== 'Tweet') return null;
  const user = record(post.user);
  const handle = str(user?.screen_name);
  // `_normal` is 48 px: the 73 px `_bigger` stays sharp at 36 dp.
  const avatar = webUrl(user?.profile_image_url_https)?.replace(/_normal(\.\w+)$/, '_bigger$1') ?? null;
  const details = Array.isArray(post.mediaDetails) ? record(post.mediaDetails[0]) : null;
  const video = details !== null && (details.type === 'video' || details.type === 'animated_gif');
  const photos = Array.isArray(post.photos) ? post.photos : [];
  const media =
    webUrl(details?.media_url_https) ?? webUrl(record(photos[0])?.url) ?? webUrl(record(post.video)?.poster);
  return {
    name: str(user?.name) ?? handle,
    handle,
    text: displayText(post),
    image: media,
    imageKind: media === null ? null : video || (details === null && record(post.video) !== null) ? 'video' : 'photo',
    avatar,
  };
}

const cache = new Map<string, Promise<XPostMeta | null>>();

/**
 * The post `id` as X serves it, `null` when X has no such post (deleted,
 * private, unknown). A network failure is not remembered: the next card
 * shown asks again.
 */
export function fetchXPost(id: string): Promise<XPostMeta | null> {
  const known = cache.get(id);
  if (known !== undefined) return known;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const request = fetch(`${ENDPOINT}?id=${id}&token=${syndicationToken(id)}&lang=en`, { signal: controller.signal })
    .then(async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseSyndication(await response.json());
    })
    .catch((error: unknown) => {
      cache.delete(id);
      throw error;
    })
    .finally(() => clearTimeout(timer));
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, request);
  return request;
}
