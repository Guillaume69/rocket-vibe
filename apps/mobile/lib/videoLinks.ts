/**
 * Detection of "embed" video links (YouTube, Dailymotion, Vimeo) in a
 * message's text.
 *
 * DETECTION owes nothing to the server: recognize the URL by pattern, extract
 * the id, and rebuild the public THUMBNAIL (predictable on YouTube and
 * Dailymotion), so a card shows even on a message the server has not (yet)
 * described. The title comes from what the server collected (`videoMetas`,
 * `lib/linkPreview.ts`), matched by `videoId`. Inline playback would need a
 * WebView (forbidden, ROADMAP §4.2): on tap, the card opens the native app or
 * the browser (`Linking`).
 *
 * Vimeo has no predictable thumbnail URL (it needs its API): it is recognized
 * anyway, and the card falls back to its degraded banner.
 */

export type VideoProvider = 'youtube' | 'dailymotion' | 'vimeo';

export type VideoLink = {
  provider: VideoProvider;
  /** Provider name ("YouTube"). */
  name: string;
  id: string;
  /** Normalized URL to open externally. */
  url: string;
  /** Public thumbnail, or `null` if the provider exposes no stable one. */
  thumbnail: string | null;
};

type Pattern = {
  provider: VideoProvider;
  name: string;
  re: RegExp;
  url: (id: string) => string;
  thumbnail: (id: string) => string | null;
};

const youTubeThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const urlYouTube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/**
 * What may precede the host: the start, or a character that cannot belong to
 * a host name or an address. Without this boundary, the pattern bit in the
 * MIDDLE of a word: `notyoutube.com/watch?v=…` and `x@youtube.com/…` produced a
 * card, while Rocket.Chat does not treat them as links (its `urls` stays
 * empty, the card would not even have a title). Non-capturing: group 1 stays
 * the id.
 */
const START = String.raw`(?:^|[^\w@.-])`;
/** Scheme and subdomain are optional: links are often posted bare. */
const HOST = String.raw`(?:https?:\/\/)?(?:www\.|m\.)?`;

const PATTERNS: readonly Pattern[] = [
  // youtu.be/ID, youtube.com/shorts|embed|live|v/ID
  {
    provider: 'youtube',
    name: 'YouTube',
    re: new RegExp(
      `${START}${HOST}(?:youtu\\.be\\/|youtube\\.com\\/(?:shorts|embed|live|v)\\/)([A-Za-z0-9_-]{11})`,
      'gi',
    ),
    url: urlYouTube,
    thumbnail: youTubeThumbnail,
  },
  // youtube.com/watch?...v=ID (v= is not necessarily the first parameter)
  {
    provider: 'youtube',
    name: 'YouTube',
    re: new RegExp(`${START}${HOST}youtube\\.com\\/watch\\?[^\\s"'<>]*v=([A-Za-z0-9_-]{11})`, 'gi'),
    url: urlYouTube,
    thumbnail: youTubeThumbnail,
  },
  // dailymotion.com/video/ID, dai.ly/ID
  {
    provider: 'dailymotion',
    name: 'Dailymotion',
    re: new RegExp(`${START}${HOST}(?:dailymotion\\.com\\/video\\/|dai\\.ly\\/)([A-Za-z0-9]+)`, 'gi'),
    url: (id) => `https://www.dailymotion.com/video/${id}`,
    thumbnail: (id) => `https://www.dailymotion.com/thumbnail/video/${id}`,
  },
  // vimeo.com/ID (numeric)
  {
    provider: 'vimeo',
    name: 'Vimeo',
    re: new RegExp(`${START}${HOST}vimeo\\.com\\/(\\d+)`, 'gi'),
    url: (id) => `https://vimeo.com/${id}`,
    thumbnail: () => null,
  },
];

/**
 * Returns the video links found in `text`, in order of appearance, without
 * duplicates (same provider + same id), capped at `max` so a message stuffed
 * with links does not drown the timeline.
 */
export function detectVideoLinks(text: string | null | undefined, max = 3): VideoLink[] {
  if (text === null || text === undefined || text === '') return [];
  const found: { pos: number; link: VideoLink }[] = [];
  const seen = new Set<string>();

  for (const m of PATTERNS) {
    m.re.lastIndex = 0; // shared regex + `g` flag: reset before each scan
    let r: RegExpExecArray | null;
    while ((r = m.re.exec(text)) !== null) {
      const id = r[1]!;
      const key = `${m.provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        pos: r.index,
        link: {
          provider: m.provider,
          name: m.name,
          id,
          url: m.url(id),
          thumbnail: m.thumbnail(id),
        },
      });
    }
  }

  found.sort((a, b) => a.pos - b.pos);
  return found.slice(0, max).map((t) => t.link);
}

/**
 * True if `url` is a video link already rendered by the embed card (YouTube,
 * Dailymotion, Vimeo). Used for deduplication: generic previews
 * (`lib/linkPreview.ts`) skip these links so as not to double the video card.
 */
export function isVideoLink(url: string): boolean {
  return videoId(url) !== null;
}

/**
 * The video id in `url`, or `null` if it is not a video. Used to match a
 * server `urls[]` entry (which carries the RAW URL, with its playlist and
 * `utm_*`) with the card detected in the text.
 */
export function videoId(url: string): string | null {
  for (const m of PATTERNS) {
    m.re.lastIndex = 0; // shared regex + `g` flag: reset before each test
    const r = m.re.exec(url);
    if (r !== null) return r[1]!;
  }
  return null;
}
