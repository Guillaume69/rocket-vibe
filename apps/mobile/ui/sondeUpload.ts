/**
 * Sonde de fin de téléversement — canal entre le transport d'upload et la
 * session DDP.
 *
 * Pourquoi elle existe : un upload multipart peut faire tomber la socket DDP
 * sans que le WebSocket n'appelle jamais son `onclose`. Le client se croit
 * alors authentifié pour toujours, `surPerte` ne part pas, le pilote de
 * reconnexion n'est jamais réveillé, et plus aucun message n'arrive (voir le
 * chien de garde de `lib/ddp.ts`, qui rattrape le cas mais doit attendre un
 * ping serveur manqué). La fin d'un upload, elle, est un signal EXACT.
 *
 * Pourquoi ici, et pas chez l'appelant : la PHOTO DE PROFIL emprunte le même
 * transport que les pièces jointes — seul le nom de champ multipart diffère.
 * Accrocher la sonde au transport, c'est couvrir d'un coup tous les endpoints
 * d'upload, présents et à venir.
 *
 * Module à état SANS dépendance native (même patron que `sourcePieceJointe`) :
 * `ui/transportUpload.ts` importe `expo-file-system`, que Node ne sait pas
 * charger — la logique vit donc ici, où elle se teste pour de vrai.
 */

let sonde: (() => void) | null = null;

/** Branchée par `ui/synchro.tsx`. `null` pour débrancher, au démontage. */
export function brancherSondeUpload(nouvelle: (() => void) | null): void {
  sonde = nouvelle;
}

/** Sans sonde branchée (tests, session fermée) : sans effet, jamais d'erreur. */
export function signalerFinUpload(): void {
  sonde?.();
}
