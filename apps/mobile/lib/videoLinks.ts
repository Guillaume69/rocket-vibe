/**
 * Détection des liens vidéo « embed » (YouTube, Dailymotion, Vimeo) dans le
 * texte d'un message.
 *
 * La DÉTECTION ne doit rien au serveur : reconnaître l'URL par motif, en tirer
 * l'identifiant, et reconstruire la VIGNETTE publique (prévisible chez YouTube
 * et Dailymotion) — une carte s'affiche donc même sur un message que le serveur
 * n'a pas (encore) décrit. Le titre, lui, vient de ce que le serveur a récolté
 * (`metasVideo`, `lib/linkPreview.ts`), rapproché par `idVideo`. La lecture
 * intégrée exigerait une WebView (interdite, ROADMAP §4.2) : la carte, au
 * toucher, ouvre l'appli native ou le navigateur (`Linking`).
 *
 * Vimeo n'a pas d'URL de vignette prévisible (il faut son API) : on le
 * reconnaît quand même, la carte tombe alors sur sa bannière dégradée.
 */

export type VideoProvider = 'youtube' | 'dailymotion' | 'vimeo';

export type VideoLink = {
  provider: VideoProvider;
  /** Nom du fournisseur (« YouTube »). */
  name: string;
  id: string;
  /** URL normalisée à ouvrir en externe. */
  url: string;
  /** Vignette publique, ou `null` si le fournisseur n'en expose pas de stable. */
  thumbnail: string | null;
};

type Motif = {
  provider: VideoProvider;
  name: string;
  re: RegExp;
  url: (id: string) => string;
  thumbnail: (id: string) => string | null;
};

const vignetteYouTube = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const urlYouTube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/**
 * Ce qui peut précéder l'hôte : le début, ou un caractère qui ne peut pas
 * appartenir à un nom d'hôte ni à une adresse. Sans cette frontière, le motif
 * mordait au MILIEU d'un mot — `notyoutube.com/watch?v=…` et `x@youtube.com/…`
 * sortaient une carte, alors que Rocket.Chat ne les tient pas pour des liens
 * (son `urls` reste vide, la carte n'aurait même pas de titre). Non capturant :
 * le groupe 1 reste l'identifiant.
 */
const DEBUT = String.raw`(?:^|[^\w@.-])`;
/** Le schéma et le sous-domaine sont optionnels — un lien se poste souvent nu. */
const HOTE = String.raw`(?:https?:\/\/)?(?:www\.|m\.)?`;

const MOTIFS: readonly Motif[] = [
  // youtu.be/ID, youtube.com/shorts|embed|live|v/ID
  {
    provider: 'youtube',
    name: 'YouTube',
    re: new RegExp(
      `${DEBUT}${HOTE}(?:youtu\\.be\\/|youtube\\.com\\/(?:shorts|embed|live|v)\\/)([A-Za-z0-9_-]{11})`,
      'gi',
    ),
    url: urlYouTube,
    thumbnail: vignetteYouTube,
  },
  // youtube.com/watch?...v=ID (le v= n'est pas forcément le premier paramètre)
  {
    provider: 'youtube',
    name: 'YouTube',
    re: new RegExp(`${DEBUT}${HOTE}youtube\\.com\\/watch\\?[^\\s"'<>]*v=([A-Za-z0-9_-]{11})`, 'gi'),
    url: urlYouTube,
    thumbnail: vignetteYouTube,
  },
  // dailymotion.com/video/ID, dai.ly/ID
  {
    provider: 'dailymotion',
    name: 'Dailymotion',
    re: new RegExp(`${DEBUT}${HOTE}(?:dailymotion\\.com\\/video\\/|dai\\.ly\\/)([A-Za-z0-9]+)`, 'gi'),
    url: (id) => `https://www.dailymotion.com/video/${id}`,
    thumbnail: (id) => `https://www.dailymotion.com/thumbnail/video/${id}`,
  },
  // vimeo.com/ID (numérique)
  {
    provider: 'vimeo',
    name: 'Vimeo',
    re: new RegExp(`${DEBUT}${HOTE}vimeo\\.com\\/(\\d+)`, 'gi'),
    url: (id) => `https://vimeo.com/${id}`,
    thumbnail: () => null,
  },
];

/**
 * Rend les liens vidéo trouvés dans `texte`, dans l'ordre d'apparition, sans
 * doublon (même fournisseur + même id), plafonnés à `max` pour qu'un message
 * truffé de liens ne noie pas le fil.
 */
export function detectVideoLinks(texte: string | null | undefined, max = 3): VideoLink[] {
  if (texte === null || texte === undefined || texte === '') return [];
  const trouves: { pos: number; link: VideoLink }[] = [];
  const vus = new Set<string>();

  for (const m of MOTIFS) {
    m.re.lastIndex = 0; // regex partagée + drapeau `g` : réarmer avant chaque balayage
    let r: RegExpExecArray | null;
    while ((r = m.re.exec(texte)) !== null) {
      const id = r[1]!;
      const cle = `${m.provider}:${id}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      trouves.push({
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

  trouves.sort((a, b) => a.pos - b.pos);
  return trouves.slice(0, max).map((t) => t.link);
}

/**
 * Vrai si `url` est un lien vidéo déjà rendu par la carte embed (YouTube,
 * Dailymotion, Vimeo). Sert à la déduplication : les aperçus génériques
 * (`lib/linkPreview.ts`) sautent ces liens pour ne pas doubler la carte vidéo.
 */
export function isVideoLink(url: string): boolean {
  return idVideo(url) !== null;
}

/**
 * L'identifiant de la vidéo dans `url`, ou `null` si ce n'en est pas une. Sert à
 * rapprocher une entrée `urls[]` du serveur (qui porte l'URL BRUTE, avec sa
 * playlist et ses `utm_*`) de la carte détectée dans le texte.
 */
export function idVideo(url: string): string | null {
  for (const m of MOTIFS) {
    m.re.lastIndex = 0; // regex partagée + drapeau `g` : réarmer avant chaque test
    const r = m.re.exec(url);
    if (r !== null) return r[1]!;
  }
  return null;
}
