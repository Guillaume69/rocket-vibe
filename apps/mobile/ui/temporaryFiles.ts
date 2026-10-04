/**
 * Ménage des fichiers temporaires (7.6).
 *
 * Préparer une pièce jointe en écrit toujours un : `ImagePicker` et
 * `DocumentPicker({copyToCacheDirectory:true})` copient le média choisi,
 * `compresserImageSiUtile` réécrit un JPEG, l'enregistreur produit un `.m4a`.
 * Rien ne les effaçait jamais — une recherche `deleteAsync` sur tout le dépôt
 * ne rendait AUCUN appel. Le seul mécanisme de purge était celui d'Android
 * sous pression disque, qui casse au passage les envois encore en file.
 *
 * **La garde est la seule chose qui compte ici.** Une URI de pièce jointe peut
 * désigner un fichier que l'utilisateur n'a pas donné à copier — un
 * `content://` du MediaStore, un fichier ouvert en place. L'effacer serait
 * détruire la photo de quelqu'un. On ne supprime donc QUE sous le répertoire
 * de cache de l'app, seul endroit dont les fichiers nous appartiennent.
 */

import * as FileSystem from 'expo-file-system/legacy';

/**
 * `null` sur les plateformes où le cache n'est pas exposé — la garde est alors
 * fermée, et rien n'est jamais supprimé. C'est le bon échec.
 */
const CACHE = FileSystem.cacheDirectory;

/** Vrai si l'URI désigne un fichier que NOUS avons écrit dans le cache de l'app. */
export function isTemporaryFile(uri: string): boolean {
  // Le natif rend parfois une chaîne vide au lieu d'une URI (l'enregistreur
  // audio, notamment) : `''.startsWith(…)` est faux, mais on le dit ici plutôt
  // que de compter sur un effet de bord.
  if (uri === '' || CACHE === null) return false;
  return uri.startsWith(CACHE);
}

/**
 * Efface un temporaire, sans jamais faire échouer l'appelant : le fichier peut
 * avoir déjà été purgé par Android, et le ménage ne vaut pas qu'on perde un
 * message pour lui.
 */
export async function deleteIfTemporary(uri: string): Promise<void> {
  if (!isTemporaryFile(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Rien à faire, et rien à dire : le prochain nettoyage d'Android l'aura.
  }
}
