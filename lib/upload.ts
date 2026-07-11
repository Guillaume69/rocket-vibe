/**
 * Upload en deux temps — `rooms.upload` a été SUPPRIMÉ en 8.0.0 :
 *
 * 1. `POST /api/v1/rooms.media/:rid` — multipart, champ `file`. Ne poste
 *    AUCUN message : le fichier attend, orphelin, côté serveur.
 * 2. `POST /api/v1/rooms.mediaConfirm/:rid/:fileId` — c'est LUI qui crée le
 *    message. Schémas relevés contre le serveur 8.5 réel (incertitude n°7) :
 *    media → `{ file: { _id, url } }` ; mediaConfirm → `{ message }` complet
 *    (attachments[], file, md), qui repasse par l'ingestion normale.
 *
 * Le POST multipart lui-même est délégué à un transport injecté :
 * `expo-file-system` dans l'app (progression native), n'importe quel `fetch`
 * dans les tests. Ce module reste pur.
 */

import type { ClientRest } from './rest.ts';

export type FichierAEnvoyer = {
  uri: string;
  nom: string;
  /** MIME. Vérifié contre `FileUpload_MediaTypeWhiteList` AVANT l'appel. */
  type: string;
};

/**
 * Envoie le multipart et rend le CORPS TEXTE de la réponse. L'implémentation
 * app utilise `expo-file-system` (createUploadTask) ; les tests, un fetch.
 */
export type TransportUpload = (
  url: string,
  entetes: Record<string, string>,
  fichier: FichierAEnvoyer,
  surProgression?: (fraction: number) => void,
) => Promise<{ statut: number; corps: string }>;

export class ErreurUpload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurUpload';
  }
}

type ReponseMedia = { file?: { _id?: string; url?: string } };
type ReponseConfirm = { message?: Record<string, unknown> };

/**
 * Le flux complet : media, puis mediaConfirm. Rend le message créé, à passer
 * à l'ingestion. `surProgression` reçoit une fraction 0..1 du téléversement.
 */
export async function televerser(options: {
  client: ClientRest;
  transport: TransportUpload;
  rid: string;
  fichier: FichierAEnvoyer;
  message?: string;
  surProgression?: (fraction: number) => void;
}): Promise<Record<string, unknown>> {
  const { client, transport, rid, fichier, message, surProgression } = options;

  const entetes: Record<string, string> = {};
  if (client.identifiants !== null) {
    entetes['X-Auth-Token'] = client.identifiants.authToken;
    entetes['X-User-Id'] = client.identifiants.userId;
  }

  const { statut, corps } = await transport(
    `${client.baseUrl}/api/v1/rooms.media/${rid}`,
    entetes,
    fichier,
    surProgression,
  );

  let media: ReponseMedia & { success?: boolean; error?: string };
  try {
    media = JSON.parse(corps) as typeof media;
  } catch {
    throw new ErreurUpload(`rooms.media : réponse non JSON (${statut}).`);
  }
  const fileId = media.file?._id;
  if (statut >= 400 || media.success === false || typeof fileId !== 'string') {
    throw new ErreurUpload(media.error ?? `rooms.media a échoué (${statut}).`);
  }

  // SANS cette confirmation, aucun message n'est posté : le fichier resterait
  // orphelin côté serveur.
  const confirmation = await client.post<ReponseConfirm>(`rooms.mediaConfirm/${rid}/${fileId}`, {
    corps: message === undefined || message === '' ? {} : { msg: message },
  });
  if (confirmation.message === undefined) {
    throw new ErreurUpload('rooms.mediaConfirm : pas de message dans la réponse.');
  }
  return confirmation.message;
}

/**
 * Lecture protégée (7.4) : `FileUpload_ProtectFiles = true` sur le serveur
 * cible — `/file-upload/:id/:nom` exige `rc_uid`/`rc_token` en query.
 */
export function urlFichierProtege(client: ClientRest, chemin: string): string {
  const absolu = chemin.startsWith('http') ? chemin : `${client.baseUrl}${chemin}`;
  if (client.identifiants === null) return absolu;
  const separateur = absolu.includes('?') ? '&' : '?';
  return `${absolu}${separateur}rc_uid=${encodeURIComponent(client.identifiants.userId)}&rc_token=${encodeURIComponent(client.identifiants.authToken)}`;
}

/**
 * URL d'avatar authentifiée. Le serveur cible a
 * `Accounts_AvatarBlockUnauthenticatedAccess = true` : sans `rc_uid`/`rc_token`
 * l'avatar répond 404/403 (vérifié sur 8.5). Rend `null` quand rien ne désigne
 * de cible — l'appelant garde alors sa tuile dégradée.
 *
 * Astuce clef : Rocket.Chat sert une VRAIE image (`image/png`, `image/jpeg`)
 * quand une photo existe, mais un SVG généré à initiales (`image/svg+xml`)
 * sinon. `<Image>` d'Android (Fresco) ne décode pas le SVG et déclenche son
 * `onError` : ce seul signal distingue « pas de photo » de « photo », sans
 * qu'on ait à synchroniser le moindre `avatarETag`.
 *
 * On vise par `uid` (message : `auteurId` ; DM : `dmAutreUid`) plutôt que par
 * pseudo — robuste aux renommages et aux points/espaces des noms — et par
 * `rid` pour l'avatar d'un canal.
 */
export function urlAvatar(
  client: ClientRest,
  cible: { uid?: string | null; username?: string | null; rid?: string | null },
): string | null {
  const { uid, username, rid } = cible;
  let chemin: string;
  if (typeof username === 'string' && username !== '') {
    chemin = `/avatar/${encodeURIComponent(username)}`;
  } else if (typeof uid === 'string' && uid !== '') {
    chemin = `/avatar/uid/${encodeURIComponent(uid)}`;
  } else if (typeof rid === 'string' && rid !== '') {
    chemin = `/avatar/room/${encodeURIComponent(rid)}`;
  } else {
    return null;
  }
  return urlFichierProtege(client, chemin);
}
