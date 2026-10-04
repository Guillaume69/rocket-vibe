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

import { sameOrigin } from './origin.ts';
import type { ClientRest } from './rest.ts';

export type FileToSend = {
  uri: string;
  name: string;
  /** MIME. Vérifié contre `FileUpload_MediaTypeWhiteList` AVANT l'appel. */
  type: string;
};

/**
 * Envoie le multipart et rend le CORPS TEXTE de la réponse. L'implémentation
 * app utilise `expo-file-system` (createUploadTask) ; les tests, un fetch.
 */
export type TransportUpload = (
  url: string,
  headers: Record<string, string>,
  file: FileToSend,
  onProgress?: (fraction: number) => void,
  /**
   * Appelé UNE fois, dès que la tâche existe, avec de quoi l'interrompre.
   * Sans cela « Abandonner » ne faisait qu'un DELETE en base : les octets
   * continuaient de monter et le fichier finissait par apparaître dans le
   * salon, après que l'utilisateur l'avait explicitement abandonné.
   */
  onCancelable?: (cancel: () => Promise<void>) => void,
  /** Champs texte ajoutés au multipart (le `content` chiffré d'un fichier de salon chiffré). */
  fields?: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurUpload';
  }
}

type MediaResponse = { file?: { _id?: string; url?: string } };
type ConfirmResponse = { message?: Record<string, unknown> };

/**
 * **Premier temps : les octets.** Rend le `fileId` du serveur — à PERSISTER
 * avant d'aller plus loin.
 *
 * Les deux temps sont séparés parce que l'intervalle entre eux est un point
 * de panne réel : `ClientRest` avorte à 15 s, et un `mediaConfirm` dont la
 * réponse se perd laissait tout reprendre à zéro au raccordement suivant —
 * les mêmes octets repoussés, un second message posté, un fichier orphelin de
 * plus. Avec le `fileId` en base, la reprise saute directement au confirm.
 *
 * `surProgression` reçoit une fraction 0..1 ; `surAnnulable`, de quoi
 * interrompre la tâche.
 */
export async function uploadBytes(options: {
  client: ClientRest;
  transport: TransportUpload;
  rid: string;
  file: FileToSend;
  onProgress?: (fraction: number) => void;
  onCancelable?: (cancel: () => Promise<void>) => void;
  fields?: Record<string, string>;
}): Promise<string> {
  const { client, transport, rid, file, onProgress, onCancelable, fields } = options;

  const headers: Record<string, string> = {};
  if (client.auth !== null) {
    headers['X-Auth-Token'] = client.auth.authToken;
    headers['X-User-Id'] = client.auth.userId;
  }

  const { status, body } = await transport(
    `${client.baseUrl}/api/v1/rooms.media/${rid}`,
    headers,
    file,
    onProgress,
    onCancelable,
    fields,
  );

  let media: MediaResponse & { success?: boolean; error?: string };
  try {
    media = JSON.parse(body) as typeof media;
  } catch {
    throw new UploadError(`rooms.media : réponse non JSON (${status}).`);
  }
  const fileId = media.file?._id;
  if (status >= 400 || media.success === false || typeof fileId !== 'string') {
    throw new UploadError(media.error ?? `rooms.media a échoué (${status}).`);
  }
  return fileId;
}

/**
 * **Second temps : le message.** SANS cette confirmation, aucun message n'est
 * posté : le fichier reste orphelin côté serveur.
 *
 * Pas d'`_id` client ici pour dédupliquer — le schéma de `rooms.mediaConfirm`
 * est `additionalProperties: false`, le serveur refuserait le corps. La
 * déduplication se fait donc côté client, sur le `fileId` persisté.
 */
export async function confirmerMedia(options: {
  client: ClientRest;
  rid: string;
  fileId: string;
  message?: string;
  /** Corps complet, à la place de `message` : celui d'un fichier chiffré. */
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { client, rid, fileId, message } = options;
  const confirmation = await client.post<ConfirmResponse>(`rooms.mediaConfirm/${rid}/${fileId}`, {
    body: options.body ?? (message === undefined || message === '' ? {} : { msg: message }),
  });
  if (confirmation.message === undefined) {
    throw new UploadError('rooms.mediaConfirm : pas de message dans la réponse.');
  }
  return confirmation.message;
}

/**
 * Change MA photo de profil : `users.setAvatar`, multipart champ **`image`**
 * (et non `file`). Endpoint distinct du flux `rooms.media` — pas de
 * confirmation en deux temps, un seul POST. Le transport (injecté) porte le nom
 * de champ ; c'est le seul écart avec `televerser`. Pas de progression : un
 * avatar réduit est minuscule.
 */
export async function setAvatar(options: {
  client: ClientRest;
  transport: TransportUpload;
  file: FileToSend;
}): Promise<void> {
  const { client, transport, file } = options;

  const headers: Record<string, string> = {};
  if (client.auth !== null) {
    headers['X-Auth-Token'] = client.auth.authToken;
    headers['X-User-Id'] = client.auth.userId;
  }

  const { status, body } = await transport(
    `${client.baseUrl}/api/v1/users.setAvatar`,
    headers,
    file,
  );

  let json: { success?: boolean; error?: string };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new UploadError(`users.setAvatar : réponse non JSON (${status}).`);
  }
  if (status >= 400 || json.success === false) {
    throw new UploadError(json.error ?? `users.setAvatar a échoué (${status}).`);
  }
}

/**
 * Lecture protégée (7.4) : `FileUpload_ProtectFiles = true` sur le serveur
 * cible — `/file-upload/:id/:nom` exige `rc_uid`/`rc_token` en query.
 *
 * **Le jeton n'est posé que sur une URL de NOTRE serveur.** `chemin` vient d'un
 * champ de message (`title_link`, `image_url`, `audio_url`, `video_url`), donc
 * en dernier ressort d'autrui : `chat.sendMessage` accepte un tableau
 * `attachments` arbitraire. Un `title_link` absolu vers un hôte tiers repartait
 * d'ici avec `rc_uid` et `rc_token` collés dessus — et il suffisait alors que
 * l'URL soit rendue par une `<Image>` pour que Fresco les livre à cet hôte,
 * sans un geste de l'utilisateur. Hors origine, on rend l'URL nue : le fichier
 * ne s'affichera pas s'il était protégé, ce qui est le bon échec.
 */
export function protectedFileUrl(client: ClientRest, path: string): string {
  const absolute = path.startsWith('http') ? path : `${client.baseUrl}${path}`;
  if (client.auth === null) return absolute;
  if (!sameOrigin(absolute, client.baseUrl)) return absolute;
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}rc_uid=${encodeURIComponent(client.auth.userId)}&rc_token=${encodeURIComponent(client.auth.authToken)}`;
}

/**
 * Valeur d'`etag` posée quand la photo a été RETIRÉE (`users.resetAvatar` :
 * l'événement `updateAvatar` arrive alors SANS etag, vérifié sur 8.5). Retirer
 * une photo doit changer l'URI autant qu'en poser une : sans ça, l'URL
 * retomberait sur sa forme d'avant, que le cache image sert encore avec
 * l'ancienne photo. Une constante suffit — l'URL correspondante rend un SVG,
 * que `<Image>` refuse, donc la tuile dégradée reprend sa place.
 */
export const AVATAR_NO_PHOTO = 'sans-photo';

/**
 * URL d'avatar authentifiée. Le serveur cible a
 * `Accounts_AvatarBlockUnauthenticatedAccess = true` : sans `rc_uid`/`rc_token`
 * l'avatar répond 404/403 (vérifié sur 8.5). Rend `null` quand rien ne désigne
 * de cible — l'appelant garde alors sa tuile dégradée.
 *
 * Astuce clef : Rocket.Chat sert une VRAIE image (`image/png`, `image/jpeg`)
 * quand une photo existe, mais un SVG généré à initiales (`image/svg+xml`)
 * sinon. `<Image>` d'Android (Fresco) ne décode pas le SVG et déclenche son
 * `onError` : ce seul signal distingue « pas de photo » de « photo ».
 *
 * `username` prime sur `uid` quand les deux sont fournis ; `rid` sert l'avatar
 * d'un canal.
 *
 * **`etag` n'est pas un ornement.** `/avatar/<qui>` est une URI STABLE : le
 * cache image d'Android (Fresco) la garde indéfiniment, sans revalidation — le
 * serveur répond pourtant `Cache-Control: public, max-age=3600` et AUCUN
 * `ETag` HTTP (relevé sur 8.5). Changer sa photo ne changeait donc rien à
 * l'écran, pour toujours. L'`avatarETag` du serveur, ajouté en query (le
 * serveur ignore le paramètre), fait bouger l'URI à chaque version : c'est LUI
 * qui rafraîchit l'affichage. Il vient de la base locale (`utilisateurs`,
 * `salons`), alimentée par le stream `updateAvatar`, par `me` et par
 * `users.info` — voir `ui/identities.tsx`.
 */
export function urlAvatar(
  client: ClientRest,
  target: {
    uid?: string | null;
    username?: string | null;
    rid?: string | null;
    etag?: string | null;
  },
): string | null {
  const { uid, username, rid, etag } = target;
  let path: string;
  if (typeof username === 'string' && username !== '') {
    path = `/avatar/${encodeURIComponent(username)}`;
  } else if (typeof uid === 'string' && uid !== '') {
    path = `/avatar/uid/${encodeURIComponent(uid)}`;
  } else if (typeof rid === 'string' && rid !== '') {
    path = `/avatar/room/${encodeURIComponent(rid)}`;
  } else {
    return null;
  }
  if (typeof etag === 'string' && etag !== '') {
    path += `?etag=${encodeURIComponent(etag)}`;
  }
  return protectedFileUrl(client, path);
}
