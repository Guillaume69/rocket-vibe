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

import { memeOrigine } from './origine.ts';
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
  /**
   * Appelé UNE fois, dès que la tâche existe, avec de quoi l'interrompre.
   * Sans cela « Abandonner » ne faisait qu'un DELETE en base : les octets
   * continuaient de monter et le fichier finissait par apparaître dans le
   * salon, après que l'utilisateur l'avait explicitement abandonné.
   */
  surAnnulable?: (annuler: () => Promise<void>) => void,
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
export async function televerserOctets(options: {
  client: ClientRest;
  transport: TransportUpload;
  rid: string;
  fichier: FichierAEnvoyer;
  surProgression?: (fraction: number) => void;
  surAnnulable?: (annuler: () => Promise<void>) => void;
}): Promise<string> {
  const { client, transport, rid, fichier, surProgression, surAnnulable } = options;

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
    surAnnulable,
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
}): Promise<Record<string, unknown>> {
  const { client, rid, fileId, message } = options;
  const confirmation = await client.post<ReponseConfirm>(`rooms.mediaConfirm/${rid}/${fileId}`, {
    corps: message === undefined || message === '' ? {} : { msg: message },
  });
  if (confirmation.message === undefined) {
    throw new ErreurUpload('rooms.mediaConfirm : pas de message dans la réponse.');
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
export async function definirAvatar(options: {
  client: ClientRest;
  transport: TransportUpload;
  fichier: FichierAEnvoyer;
}): Promise<void> {
  const { client, transport, fichier } = options;

  const entetes: Record<string, string> = {};
  if (client.identifiants !== null) {
    entetes['X-Auth-Token'] = client.identifiants.authToken;
    entetes['X-User-Id'] = client.identifiants.userId;
  }

  const { statut, corps } = await transport(
    `${client.baseUrl}/api/v1/users.setAvatar`,
    entetes,
    fichier,
  );

  let json: { success?: boolean; error?: string };
  try {
    json = JSON.parse(corps) as typeof json;
  } catch {
    throw new ErreurUpload(`users.setAvatar : réponse non JSON (${statut}).`);
  }
  if (statut >= 400 || json.success === false) {
    throw new ErreurUpload(json.error ?? `users.setAvatar a échoué (${statut}).`);
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
export function urlFichierProtege(client: ClientRest, chemin: string): string {
  const absolu = chemin.startsWith('http') ? chemin : `${client.baseUrl}${chemin}`;
  if (client.identifiants === null) return absolu;
  if (!memeOrigine(absolu, client.baseUrl)) return absolu;
  const separateur = absolu.includes('?') ? '&' : '?';
  return `${absolu}${separateur}rc_uid=${encodeURIComponent(client.identifiants.userId)}&rc_token=${encodeURIComponent(client.identifiants.authToken)}`;
}

/**
 * Valeur d'`etag` posée quand la photo a été RETIRÉE (`users.resetAvatar` :
 * l'événement `updateAvatar` arrive alors SANS etag, vérifié sur 8.5). Retirer
 * une photo doit changer l'URI autant qu'en poser une : sans ça, l'URL
 * retomberait sur sa forme d'avant, que le cache image sert encore avec
 * l'ancienne photo. Une constante suffit — l'URL correspondante rend un SVG,
 * que `<Image>` refuse, donc la tuile dégradée reprend sa place.
 */
export const AVATAR_SANS_PHOTO = 'sans-photo';

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
 * `users.info` — voir `ui/identites.tsx`.
 */
export function urlAvatar(
  client: ClientRest,
  cible: {
    uid?: string | null;
    username?: string | null;
    rid?: string | null;
    etag?: string | null;
  },
): string | null {
  const { uid, username, rid, etag } = cible;
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
  if (typeof etag === 'string' && etag !== '') {
    chemin += `?etag=${encodeURIComponent(etag)}`;
  }
  return urlFichierProtege(client, chemin);
}
