/**
 * Câblage natif de `lib/fichierJoint.ts` : `expo-file-system/legacy` pour
 * télécharger dans le cache, `expo-sharing` pour ouvrir la feuille de partage
 * sur le fichier local.
 *
 * `expo-sharing` est un binding natif de niveau 1 au sens de ROADMAP §4.2 — il
 * expose `Intent.ACTION_SEND` et pose son propre `FileProvider`, sans imposer
 * ni composant ni look. Aucun config plugin à écrire ; `expo install` a ajouté
 * son entrée dans `app.json`, mais il faut un `prebuild` + rebuild pour que le
 * module existe côté natif.
 *
 * La logique (assainissement du nom, dossier par identifiant de fichier) reste
 * dans `lib/`, où elle se teste sous Node : ce fichier-ci n'est pas importable
 * hors appareil. Même patron que `ui/transportUpload.ts`.
 */

import { Directory, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { ouvrirFichierJoint, telechargerFichierJoint, versGalerie } from '../lib/fichierJoint.ts';

/** Levée quand rien ne peut ouvrir le fichier : l'appelant en informe l'écran. */
export class ErreurOuvertureFichier extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurOuvertureFichier';
  }
}

/**
 * Télécharge la pièce jointe protégée puis propose de l'ouvrir. L'URL
 * authentifiée ne sort pas du processus : seul le `file://` local est confié au
 * système.
 */
export async function ouvrirJointeProtegee(options: {
  url: string;
  titre: string | null | undefined;
  type: string | null | undefined;
}): Promise<void> {
  const dossier = FileSystem.cacheDirectory;
  if (dossier === null) {
    throw new ErreurOuvertureFichier('Aucun dossier de cache disponible.');
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new ErreurOuvertureFichier('Le partage de fichiers est indisponible.');
  }

  await ouvrirFichierJoint({
    ...options,
    dossier,
    creerDossier: async (chemin) => {
      await FileSystem.makeDirectoryAsync(chemin, { intermediates: true });
    },
    telecharger: telechargerDansLeCache,
    partager: async (fichierLocal, type) => {
      await Sharing.shareAsync(fichierLocal, type === null ? {} : { mimeType: type });
    },
  });
}

// Un 401/403/404 s'écrit quand même sur le disque : sans ce contrôle, on
// partagerait ou enregistrerait le corps JSON de l'erreur en croyant tenir le fichier.
async function telechargerDansLeCache(url: string, destination: string): Promise<void> {
  const res = await FileSystem.downloadAsync(url, destination);
  if (res.status !== 200) {
    throw new ErreurOuvertureFichier(`Téléchargement refusé (HTTP ${res.status}).`);
  }
}

/** `galerie`, `dossier`, ou `null` quand l'utilisateur a refermé le sélecteur de dossier. */
export type LieuEnregistrement = 'galerie' | 'dossier' | null;

/**
 * Télécharge la pièce jointe protégée puis l'ENREGISTRE sur l'appareil : photo,
 * vidéo et son dans la galerie (MediaStore, sans permission depuis Android 10),
 * tout autre fichier dans un dossier choisi par l'utilisateur.
 */
export async function enregistrerJointeProtegee(options: {
  url: string;
  titre: string | null | undefined;
  type: string | null | undefined;
}): Promise<LieuEnregistrement> {
  const dossier = FileSystem.cacheDirectory;
  if (dossier === null) {
    throw new ErreurOuvertureFichier('Aucun dossier de cache disponible.');
  }
  const local = await telechargerFichierJoint({
    ...options,
    dossier,
    creerDossier: async (chemin) => {
      await FileSystem.makeDirectoryAsync(chemin, { intermediates: true });
    },
    telecharger: telechargerDansLeCache,
  });
  const nom = local.slice(local.lastIndexOf('/') + 1);

  if (versGalerie(nom, options.type)) {
    try {
      await Asset.create(local);
    } catch {
      // Android 9 et avant : l'écriture dans le stockage partagé exige encore
      // la permission. On la demande, puis on réessaie une fois.
      const permission = await requestPermissionsAsync(true);
      if (!permission.granted) throw new ErreurOuvertureFichier('Permission refusée.');
      await Asset.create(local);
    }
    return 'galerie';
  }

  let cible: Directory;
  try {
    cible = await Directory.pickDirectoryAsync();
  } catch {
    return null;
  }
  const fichier = cible.createFile(nom, options.type ?? 'application/octet-stream');
  fichier.write(await new File(local).bytes());
  return 'dossier';
}
