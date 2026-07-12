/**
 * Détection des liens vidéo « embed » (YouTube, Dailymotion, Vimeo) dans le
 * texte d'un message.
 *
 * On NE lit PAS les métadonnées de lien du serveur : l'app n'ingère ni `urls`
 * ni oEmbed, et surtout la lecture intégrée exigerait une WebView — interdite
 * (ROADMAP §4.2). On se contente donc du réalisable et propre : reconnaître
 * l'URL par motif, en tirer l'identifiant, et reconstruire la VIGNETTE publique
 * (prévisible chez YouTube et Dailymotion). La carte, au toucher, ouvre l'appli
 * native ou le navigateur (`Linking`) — aucune WebView, aucun flux à extraire.
 *
 * Vimeo n'a pas d'URL de vignette prévisible (il faut son API) : on le
 * reconnaît quand même, la carte tombe alors sur sa bannière dégradée.
 */

export type FournisseurVideo = 'youtube' | 'dailymotion' | 'vimeo';

export type LienVideo = {
  provider: FournisseurVideo;
  /** Nom affiché (« YouTube »). */
  nom: string;
  id: string;
  /** URL normalisée à ouvrir en externe. */
  url: string;
  /** Vignette publique, ou `null` si le fournisseur n'en expose pas de stable. */
  vignette: string | null;
};

type Motif = {
  provider: FournisseurVideo;
  nom: string;
  re: RegExp;
  url: (id: string) => string;
  vignette: (id: string) => string | null;
};

const vignetteYouTube = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const urlYouTube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

const MOTIFS: readonly Motif[] = [
  // youtu.be/ID, youtube.com/shorts|embed|live|v/ID
  {
    provider: 'youtube',
    nom: 'YouTube',
    re: /(?:youtu\.be\/|youtube\.com\/(?:shorts|embed|live|v)\/)([A-Za-z0-9_-]{11})/gi,
    url: urlYouTube,
    vignette: vignetteYouTube,
  },
  // youtube.com/watch?...v=ID (le v= n'est pas forcément le premier paramètre)
  {
    provider: 'youtube',
    nom: 'YouTube',
    re: /youtube\.com\/watch\?[^\s"'<>]*v=([A-Za-z0-9_-]{11})/gi,
    url: urlYouTube,
    vignette: vignetteYouTube,
  },
  // dailymotion.com/video/ID, dai.ly/ID
  {
    provider: 'dailymotion',
    nom: 'Dailymotion',
    re: /(?:dailymotion\.com\/video\/|dai\.ly\/)([A-Za-z0-9]+)/gi,
    url: (id) => `https://www.dailymotion.com/video/${id}`,
    vignette: (id) => `https://www.dailymotion.com/thumbnail/video/${id}`,
  },
  // vimeo.com/ID (numérique)
  {
    provider: 'vimeo',
    nom: 'Vimeo',
    re: /vimeo\.com\/(\d+)/gi,
    url: (id) => `https://vimeo.com/${id}`,
    vignette: () => null,
  },
];

/**
 * Rend les liens vidéo trouvés dans `texte`, dans l'ordre d'apparition, sans
 * doublon (même fournisseur + même id), plafonnés à `max` pour qu'un message
 * truffé de liens ne noie pas le fil.
 */
export function detecterLiensVideo(texte: string | null | undefined, max = 3): LienVideo[] {
  if (texte === null || texte === undefined || texte === '') return [];
  const trouves: { pos: number; lien: LienVideo }[] = [];
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
        lien: {
          provider: m.provider,
          nom: m.nom,
          id,
          url: m.url(id),
          vignette: m.vignette(id),
        },
      });
    }
  }

  trouves.sort((a, b) => a.pos - b.pos);
  return trouves.slice(0, max).map((t) => t.lien);
}

/**
 * Vrai si `url` est un lien vidéo déjà rendu par la carte embed (YouTube,
 * Dailymotion, Vimeo). Sert à la déduplication : les aperçus génériques
 * (`lib/apercuLien.ts`) sautent ces liens pour ne pas doubler la carte vidéo.
 */
export function estLienVideo(url: string): boolean {
  return MOTIFS.some((m) => {
    m.re.lastIndex = 0; // regex partagée + drapeau `g` : réarmer avant chaque test
    return m.re.test(url);
  });
}
