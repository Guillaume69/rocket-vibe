/**
 * Ouvrir une pièce jointe « fichier » (PDF, archive, tableur…) SANS laisser
 * sortir le jeton.
 *
 * L'URL d'un fichier protégé porte `rc_uid`/`rc_token` en query — le middleware
 * de Rocket.Chat s'authentifie ainsi, pas par en-tête (basculer sur
 * `X-Auth-Token` serait un 403 déguisé en correctif). La confier à
 * `Linking.openURL` la déposait dans Chrome, son historique et sa
 * synchronisation ; l'image et la vidéo, elles, respectaient déjà l'invariant
 * de `ui/visionneuse.tsx` en gardant l'URL en mémoire.
 *
 * On fait donc ce que fait la visionneuse, en deux temps : **télécharger dans
 * le cache** (la requête authentifiée reste dans le processus), puis **partager
 * le fichier LOCAL** via la feuille de partage Android — qui reçoit un
 * `content://` de notre FileProvider, sans un octet de secret.
 *
 * Module pur : les trois capacités natives (créer un dossier, télécharger,
 * partager) sont injectées, `ui/fichierJoint.ts` les câble. Même patron que
 * `TransportUpload` (lib/upload.ts).
 */

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

/**
 * Télécharge la pièce jointe et ouvre la feuille de partage dessus. Rend le
 * chemin local, pour que l'appelant puisse le journaliser ou le rouvrir.
 *
 * `url` porte le jeton et ne quitte JAMAIS cette fonction : elle n'est passée
 * qu'à `telecharger`, dont l'implémentation fait une requête HTTP interne.
 * `partager` ne reçoit que le chemin local.
 */
export async function ouvrirFichierJoint(options: {
  /** URL protégée, jeton compris. */
  url: string;
  /** `title` du message — proposé par autrui, donc assaini. */
  titre: string | null | undefined;
  /** MIME annoncé, passé tel quel à la feuille de partage. */
  type: string | null | undefined;
  /** Dossier de cache de l'app (`file:///…/cache/`). */
  dossier: string;
  creerDossier: CreerDossier;
  telecharger: TelechargerFichier;
  partager: PartagerFichier;
}): Promise<string> {
  const { url, titre, type, dossier, creerDossier, telecharger, partager } = options;

  const racine = dossier.endsWith('/') ? dossier : `${dossier}/`;
  const sousDossier = `${racine}jointes/${cleDeFichier(url)}/`;
  // Le `title` d'abord (c'est ce que l'utilisateur voit dans le fil), le dernier
  // segment de l'URL en repli — décodé, sans quoi `mon%20rapport.pdf`
  // s'écrirait avec son `%20`.
  const depuisUrl = segments(url).at(-1);
  const nom = nomDeFichierSur(
    typeof titre === 'string' && titre.trim() !== ''
      ? titre
      : depuisUrl === undefined
        ? null
        : decoder(depuisUrl),
  );
  const destination = `${sousDossier}${nom}`;

  await creerDossier(sousDossier);
  await telecharger(url, destination);
  await partager(destination, typeof type === 'string' && type !== '' ? type : null);
  return destination;
}
