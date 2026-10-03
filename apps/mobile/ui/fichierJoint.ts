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

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { dechiffrerFichier, type ChiffrementFichier } from '../lib/e2e/crypto.ts';
import { fractionTelechargee, telechargerFichierJoint, versGalerie } from '../lib/fichierJoint.ts';
import { Telechargements } from '../modules/telechargements/index.ts';
import {chargerFichierNatif} from '../lib/fichiersNatifs.ts';
import type { Progression } from './transferts.ts';

/** Levée quand rien ne peut ouvrir le fichier : l'appelant en informe l'écran. */
export class ErreurOuvertureFichier extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurOuvertureFichier';
  }
}

type OptionsJointe = {
  url: string;
  titre: string | null | undefined;
  type: string | null | undefined;
  /** Poids annoncé par le message, en octets. */
  taille?: number | null;
  /** Fichier d'un salon chiffré : on télécharge du chiffré, on garde le clair. */
  chiffrement?: ChiffrementFichier | null;
  surProgression?: (p: Progression) => void;
};

/**
 * Télécharge dans le cache, ou y retrouve le fichier : l'écriture passe par un
 * `.part` renommé à la fin, donc un fichier présent sous son vrai nom est
 * COMPLET. Partager après avoir enregistré ne retélécharge rien.
 */
async function versLeCache(options: OptionsJointe): Promise<string> {
  if(options.url.startsWith('rv-file:'))return chargerFichierNatif(options.url,options.surProgression);
  const dossier = FileSystem.cacheDirectory;
  if (dossier === null) {
    throw new ErreurOuvertureFichier('Aucun dossier de cache disponible.');
  }
  return telechargerFichierJoint({
    ...options,
    dossier,
    creerDossier: async (chemin) => {
      await FileSystem.makeDirectoryAsync(chemin, { intermediates: true });
    },
    telecharger: async (url, destination) => {
      if ((await FileSystem.getInfoAsync(destination)).exists) return;
      // Un fichier déjà déchiffré dans NOTRE cache (la visionneuse qui
      // enregistre une image chiffrée) : rien à télécharger.
      if (url.startsWith(dossier)) {
        await FileSystem.copyAsync({ from: url, to: destination });
        return;
      }
      const partiel = `${destination}.part`;
      const tache = FileSystem.createDownloadResumable(url, partiel, {}, (e) => {
        options.surProgression?.(
          fractionTelechargee(e.totalBytesWritten, e.totalBytesExpectedToWrite, options.taille),
        );
      });
      const res = await tache.downloadAsync();
      // Un 401/403/404 s'écrit quand même sur le disque : sans ce contrôle, on
      // partagerait ou enregistrerait le corps JSON de l'erreur.
      if (res === undefined || res.status !== 200) {
        await FileSystem.deleteAsync(partiel, { idempotent: true });
        throw new ErreurOuvertureFichier(`Téléchargement refusé (HTTP ${res?.status ?? 0}).`);
      }
      if (options.chiffrement) {
        const base64 = { encoding: FileSystem.EncodingType.Base64 };
        try {
          const chiffre = Buffer.from(await FileSystem.readAsStringAsync(partiel, base64), 'base64');
          const clair = dechiffrerFichier(chiffre, options.chiffrement);
          await FileSystem.writeAsStringAsync(partiel, clair.toString('base64'), base64);
        } catch {
          await FileSystem.deleteAsync(partiel, { idempotent: true });
          throw new ErreurOuvertureFichier('Fichier chiffré illisible.');
        }
      }
      await FileSystem.moveAsync({ from: partiel, to: destination });
    },
  });
}

const enCours = new Map<string, Promise<string>>();

/**
 * Le fichier clair d'une pièce jointe chiffrée, dans le cache — pour l'afficher.
 * Une même pièce vue deux fois à l'écran ne se télécharge qu'une fois.
 */
export function fichierDechiffre(options: OptionsJointe): Promise<string> {
  const existante = enCours.get(options.url);
  if (existante !== undefined) return existante;
  const promesse = versLeCache(options).finally(() => enCours.delete(options.url));
  enCours.set(options.url, promesse);
  return promesse;
}

/**
 * Télécharge la pièce jointe protégée puis ouvre la feuille de partage dessus.
 * L'URL authentifiée ne sort pas du processus : seul le `file://` local est
 * confié au système.
 */
export async function ouvrirJointeProtegee(options: OptionsJointe): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ErreurOuvertureFichier('Le partage de fichiers est indisponible.');
  }
  const local = await versLeCache(options);
  await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : {});
}

/** Confie au système un fichier DÉJÀ local (une pièce pas encore envoyée). */
export async function ouvrirFichierLocal(uri: string, type: string | null): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ErreurOuvertureFichier('Le partage de fichiers est indisponible.');
  }
  await Sharing.shareAsync(uri, type ? { mimeType: type } : {});
}

export type LieuEnregistrement = 'galerie' | 'telechargements' | 'partage';

/**
 * Télécharge la pièce jointe protégée puis l'ENREGISTRE sur l'appareil : photo,
 * vidéo et son dans la galerie, tout autre fichier dans Téléchargements — les
 * deux par MediaStore, sans permission depuis Android 10.
 */
export async function enregistrerJointeProtegee(options: OptionsJointe): Promise<LieuEnregistrement> {
  const local = await versLeCache(options);
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

  // iOS n'a pas de dossier Téléchargements : la feuille de partage propose
  // « Enregistrer dans Fichiers ».
  if (Telechargements === null) {
    await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : undefined);
    return 'partage';
  }
  await Telechargements.enregistrer(local, nom, options.type ?? null);
  return 'telechargements';
}
