/**
 * Ouvrir une pièce jointe « fichier » (PDF, archive, tableur…) SANS laisser
 * sortir le jeton.
 *
 * L'URL d'un fichier protégé porte `rc_uid`/`rc_token` en query — le middleware
 * de Rocket.Chat s'authentifie ainsi, pas par en-tête (basculer sur
 * `X-Auth-Token` serait un 403 déguisé en correctif). La confier à
 * `Linking.openURL` la déposait dans Chrome, son historique et sa
 * synchronisation ; l'image et la vidéo, elles, respectaient déjà l'invariant
 * de `ui/imageViewer.tsx` en gardant l'URL en mémoire.
 *
 * On fait donc ce que fait la visionneuse, en deux temps : **télécharger dans
 * le cache** (la requête authentifiée reste dans le processus), puis **partager
 * le fichier LOCAL** via la feuille de partage Android — qui reçoit un
 * `content://` de notre FileProvider, sans un octet de secret.
 *
 * Module pur : les trois capacités natives (créer un dossier, télécharger,
 * partager) sont injectées, `ui/attachment.ts` les câble. Même patron que
 * `TransportUpload` (lib/upload.ts).
 */

import { estJointeCitation } from './quote.ts';
import { chiffrementDeJointe, type ChiffrementFichier } from './e2e/crypto.ts';

/** Crée un dossier et ses parents. Doit être sans effet s'il existe déjà. */
export type CreerDossier = (chemin: string) => Promise<void>;

/** Télécharge `url` (authentifiée) vers `destination`, un `file://` local. */
export type TelechargerFichier = (url: string, destination: string) => Promise<void>;

/** Ouvre la feuille de partage du système sur un fichier LOCAL. */
export type PartagerFichier = (fichierLocal: string, type: string | null) => Promise<void>;

/** Nom de dernier recours, quand le message n'en propose aucun d'exploitable. */
const NOM_REPLI = 'fichier';

/** Sous-dossier de dernier recours, quand l'URL ne porte pas d'identifiant. */
const CLE_REPLI = 'divers';

/**
 * Caractères qu'un nom de fichier ne doit pas porter : contrôles, et ceux que
 * les systèmes de fichiers (ou les applications réceptrices) traitent à part.
 *
 * On s'écarte ici du `[A-Za-z0-9._-]` prescrit par l'audit, qui aurait rendu
 * `résumé-2026.pdf` en `r_sum_-2026.pdf` sous les yeux de l'utilisateur. Ce
 * qu'il faut garantir est plus étroit : que le nom ne puisse pas s'échapper du
 * dossier de destination. Les séparateurs sont retirés en amont (on ne garde
 * que le dernier segment), les points de tête et de queue aussi — donc ni `.`,
 * ni `..`, ni chemin. Le reste des lettres peut vivre.
 */
const HOSTILES =/[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Longueur max d'un nom de fichier — sous la limite ext4 (255 octets). */
const NOM_MAX = 120;

function plafonner(nom: string): string {
  if (nom.length <= NOM_MAX) return nom;
  const point = nom.lastIndexOf('.');
  // Extension conservée seulement si elle en a l'air : c'est elle qui décide de
  // l'application qui s'ouvrira.
  const ext = point > 0 && nom.length - point <= 12 ? nom.slice(point) : '';
  return nom.slice(0, NOM_MAX - ext.length) + ext;
}

/** Segments non vides du CHEMIN d'une URL (query et fragment retirés). */
function segments(url: string): string[] {
  const chemin = url.split(/[?#]/)[0] ?? '';
  return chemin.split('/').filter((s) => s !== '' && s !== '.');
}

function decoder(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Un `%` isolé dans le nom : on garde la forme brute plutôt que rien.
    return s;
  }
}

/**
 * Nom de destination sûr à partir d'un nom proposé par autrui (le `title` du
 * message, ou le dernier segment de l'URL). Ne peut jamais désigner autre chose
 * qu'un fichier du dossier de destination.
 */
export function nomDeFichierSur(propose: string | null | undefined): string {
  const brut = typeof propose === 'string' ? propose : '';
  // `../../evil.sh` → `evil.sh` : seul le dernier segment est retenu, ce qui
  // neutralise la remontée de dossier avant même l'assainissement.
  const parts = brut.split(/[/\\]/).filter((s) => s !== '');
  const dernier = parts.length > 0 ? parts[parts.length - 1]! : '';
  const propre = dernier.replace(HOSTILES, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return propre === '' ? NOM_REPLI : plafonner(propre);
}

/**
 * Identifiant du fichier côté serveur, extrait de l'URL
 * (`/file-upload/<_id>/<nom>`), pour servir de SOUS-DOSSIER de cache.
 *
 * Sans lui, deux pièces jointes nommées `facture.pdf` se recouvriraient dans le
 * cache — et un partage lancé sur l'une pourrait présenter l'autre. L'`_id`
 * Rocket.Chat est immuable, le dossier est donc stable d'une ouverture à
 * l'autre.
 */
export function cleDeFichier(url: string): string {
  const parts = segments(url);
  const brut = parts.length >= 2 ? parts[parts.length - 2]! : '';
  const propre = brut.replace(/[^A-Za-z0-9_-]/g, '');
  return propre === '' ? CLE_REPLI : propre.slice(0, 64);
}

const EXTENSIONS_PAR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
};

const A_UNE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Complète un nom sans extension d'après le MIME. C'est l'extension qui décide
 * de l'application qui ouvrira le fichier, et de l'endroit où la galerie le
 * range : un `photo` nu y serait classé comme une image quelconque.
 */
export function avecExtension(nom: string, type: string | null | undefined): string {
  if (A_UNE_EXTENSION.test(nom) || typeof type !== 'string') return nom;
  const mime = type.toLowerCase().split(';')[0]!.trim();
  const connue = EXTENSIONS_PAR_TYPE[mime];
  if (connue !== undefined) return `${nom}.${connue}`;
  const sousType = mime.split('/')[1] ?? '';
  return /^[a-z0-9]{1,8}$/.test(sousType) ? `${nom}.${sousType}` : nom;
}

const EXTENSIONS_MEDIA = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  'mp4', 'mov', 'webm', 'mkv', '3gp', 'm4v',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac',
]);

/**
 * Photo, vidéo ou son : la galerie (MediaStore) sait les ranger. Tout le
 * reste (PDF, archive…) va dans un dossier choisi par l'utilisateur.
 */
export function versGalerie(nom: string, type: string | null | undefined): boolean {
  if (typeof type === 'string' && /^(image|video|audio)\//i.test(type)) return true;
  const ext = nom.slice(nom.lastIndexOf('.') + 1).toLowerCase();
  return nom.includes('.') && EXTENSIONS_MEDIA.has(ext);
}

/**
 * Télécharge la pièce jointe dans le cache et rend son chemin local.
 *
 * `url` porte le jeton et ne quitte JAMAIS cette fonction : elle n'est passée
 * qu'à `telecharger`, dont l'implémentation fait une requête HTTP interne.
 */
export async function telechargerFichierJoint(options: {
  /** URL protégée, jeton compris. */
  url: string;
  /** `title` du message — proposé par autrui, donc assaini. */
  titre: string | null | undefined;
  /** MIME annoncé : complète l'extension quand le nom n'en a pas. */
  type: string | null | undefined;
  /** Dossier de cache de l'app (`file:///…/cache/`). */
  dossier: string;
  creerDossier: CreerDossier;
  telecharger: TelechargerFichier;
}): Promise<string> {
  const { url, titre, type, dossier, creerDossier, telecharger } = options;

  const racine = dossier.endsWith('/') ? dossier : `${dossier}/`;
  const sousDossier = `${racine}jointes/${cleDeFichier(url)}/`;
  // Le `title` d'abord (c'est ce que l'utilisateur voit dans le fil), le dernier
  // segment de l'URL en repli — décodé, sans quoi `mon%20rapport.pdf`
  // s'écrirait avec son `%20`.
  const depuisUrl = segments(url).at(-1);
  const nom = avecExtension(
    nomDeFichierSur(
      typeof titre === 'string' && titre.trim() !== ''
        ? titre
        : depuisUrl === undefined
          ? null
          : decoder(depuisUrl),
    ),
    type,
  );
  const destination = `${sousDossier}${nom}`;

  await creerDossier(sousDossier);
  await telecharger(url, destination);
  return destination;
}

/**
 * Télécharge la pièce jointe et ouvre la feuille de partage dessus. Rend le
 * chemin local ; `partager` ne reçoit que lui, jamais l'URL.
 */
export async function ouvrirFichierJoint(options: {
  url: string;
  titre: string | null | undefined;
  /** MIME annoncé, passé tel quel à la feuille de partage. */
  type: string | null | undefined;
  dossier: string;
  creerDossier: CreerDossier;
  telecharger: TelechargerFichier;
  partager: PartagerFichier;
}): Promise<string> {
  const { partager, ...reste } = options;
  const destination = await telechargerFichierJoint(reste);
  await partager(destination, typeof options.type === 'string' && options.type !== '' ? options.type : null);
  return destination;
}

export type JointePartageable = {
  /** Chemin (relatif au serveur) de l'ORIGINAL, sans jeton. */
  chemin: string;
  titre: string | null;
  type: string | null;
  /** Poids annoncé par le message, en octets : la progression s'y rapporte quand le serveur tait le sien. */
  taille: number | null;
  /** Fichier d'un salon chiffré : sa clé, pour le rendre en clair. */
  chiffrement: ChiffrementFichier | null;
};

type JointeBrute = {
  title?: unknown;
  title_link?: unknown;
  image_url?: unknown;
  video_url?: unknown;
  audio_url?: unknown;
  image_type?: unknown;
  video_type?: unknown;
  audio_type?: unknown;
  size?: unknown;
  image_size?: unknown;
  video_size?: unknown;
  audio_size?: unknown;
};

function octets(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function chaine(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * La première pièce jointe du message qu'on peut partager comme FICHIER :
 * `title_link` d'abord, qui désigne l'original là où `image_url` n'est que la
 * vignette. Les citations sont ignorées : on partage ce que le message porte.
 */
export function jointeAPartager(piecesJointes: string | null): JointePartageable | null {
  let brut: unknown;
  try {
    brut = JSON.parse(piecesJointes ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(brut)) return null;
  for (const jointe of brut as unknown[]) {
    if (typeof jointe !== 'object' || jointe === null || estJointeCitation(jointe)) continue;
    const j = jointe as JointeBrute;
    const chemin =
      chaine(j.title_link) ?? chaine(j.image_url) ?? chaine(j.video_url) ?? chaine(j.audio_url);
    if (chemin === null) continue;
    return {
      chemin,
      titre: chaine(j.title),
      type: chaine(j.image_type) ?? chaine(j.video_type) ?? chaine(j.audio_type),
      taille: octets(j.size) ?? octets(j.image_size) ?? octets(j.video_size) ?? octets(j.audio_size),
      chiffrement: chiffrementDeJointe(jointe),
    };
  }
  return null;
}

/**
 * Fraction téléchargée. Le serveur de fichiers ne répond pas toujours avec sa
 * taille (réponse en `chunked`) : on se rapporte alors au poids annoncé par le
 * message, plafonné à 1. `null` si on ne sait rien du tout.
 */
export function fractionTelechargee(
  ecrits: number,
  attendus: number,
  taille: number | null | undefined,
): number | null {
  const total = attendus > 0 ? attendus : (taille ?? 0);
  return total > 0 ? Math.min(ecrits / total, 1) : null;
}

/**
 * Le nom sous lequel téléverser un fichier local, quand celui de son URI n'est
 * pas le sien. Le multipart d'`expo-file-system` prend le nom du fichier sur
 * le disque, et le serveur le garde tel quel : une copie de cache (sélecteur,
 * réduction) partirait sous un nom aléatoire. `null` : l'URI porte déjà le bon.
 */
export function nomATeleverser(uri: string, nom: string): string | null {
  const voulu = nomDeFichierSur(nom);
  const actuel = decoder(uri.split(/[?#]/)[0]!.split('/').pop() ?? '');
  return actuel === voulu ? null : voulu;
}
