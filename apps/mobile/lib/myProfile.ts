/**
 * Mon profil — lecture et écriture de MES propres informations.
 *
 * Deux endpoints REST, aux règles bien différentes :
 *  - `users.setStatus` : présence (online/away/busy/offline) ET texte de statut
 *    (le champ `message`). Léger, jamais gardé par un second facteur.
 *  - `users.updateOwnBasicInfo` : nom, bio, e-mail, nom d'utilisateur. Changer
 *    l'e-mail ou le nom d'utilisateur est SENSIBLE : le serveur exige le mot de
 *    passe courant — haché en SHA-256, jamais en clair, comme la méthode 2FA
 *    `password` (cf. lib/auth.ts) — dans `data.currentPassword`, et lève souvent
 *    la 2FA générique (`totp-required`). L'appelant rejoue alors avec le code
 *    préparé, via les en-têtes `x-2fa-*` (même mécanique que le login).
 *
 * Comme le reste de lib/, ce module n'importe pas react-native : le hachage du
 * mot de passe est fait par l'appelant (expo-crypto dans l'app), pas ici.
 */

import type { ClientRest, TwoFactorCode } from './rest.ts';

/** Statut CHOISI par l'utilisateur (statusDefault), distinct de la présence live. */
export type DefaultStatus = 'online' | 'away' | 'busy' | 'offline';

export type MyProfile = {
  username: string;
  name: string;
  email: string;
  status: DefaultStatus;
  statusText: string;
  bio: string;
};

const STATUTS: readonly DefaultStatus[] = ['online', 'away', 'busy', 'offline'];

function estStatut(v: unknown): v is DefaultStatus {
  return typeof v === 'string' && (STATUTS as readonly string[]).includes(v);
}

/** Toujours une chaîne : les champs de formulaire ne veulent pas d'`undefined`. */
function chaine(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

type ReponseMe = {
  _id?: unknown;
  username?: unknown;
  name?: unknown;
  /** Version de MA photo de profil — cache-buster de l'URL d'avatar. */
  avatarETag?: unknown;
  /** Présence LIVE (fluctue avec la connexion) — pas ce qu'on édite. */
  status?: unknown;
  /** Statut CHOISI (sticky) — ce que l'éditeur doit refléter. */
  statusDefault?: unknown;
  statusText?: unknown;
  bio?: unknown;
  emails?: unknown;
};

/** Premier e-mail du compte (`emails[0].address`), '' s'il n'y en a pas. */
function premierEmail(emails: unknown): string {
  if (!Array.isArray(emails) || emails.length === 0) return '';
  const p: unknown = emails[0];
  return p !== null && typeof p === 'object' && 'address' in p
    ? chaine((p as { address?: unknown }).address)
    : '';
}

export function profileFromMe(brut: ReponseMe): MyProfile {
  return {
    username: chaine(brut.username),
    name: chaine(brut.name),
    email: premierEmail(brut.emails),
    // `statusDefault` (le choix) prime sur `status` (la présence live, qui
    // vaut « offline » à froid tant que la session DDP n'est pas établie).
    status: estStatut(brut.statusDefault)
      ? brut.statusDefault
      : estStatut(brut.status)
        ? brut.status
        : 'offline',
    statusText: chaine(brut.statusText),
    bio: chaine(brut.bio),
  };
}

export function readMyProfile(client: ClientRest): Promise<MyProfile> {
  return client.get<ReponseMe>('me').then(profileFromMe);
}

/**
 * Mon identité telle que la base locale la range : uid, pseudo courant, et
 * version de ma photo. C'est le SEUL rattrapage possible d'un avatar changé
 * pendant que l'app était fermée — aucun stream n'a pu l'annoncer. `me` la
 * porte sans requête supplémentaire dédiée (vérifié sur 8.5).
 */
export type MyIdentity = { uid: string; username: string; avatarEtag: string | null };

export function identityFromMe(brut: ReponseMe): MyIdentity | null {
  const uid = chaine(brut._id);
  const username = chaine(brut.username);
  if (uid === '' || username === '') return null;
  const etag = chaine(brut.avatarETag);
  return { uid, username, avatarEtag: etag === '' ? null : etag };
}

export function readMyIdentity(client: ClientRest): Promise<MyIdentity | null> {
  return client.get<ReponseMe>('me').then(identityFromMe);
}

/**
 * Présence + texte de statut. On envoie TOUJOURS les deux : `users.setStatus`
 * remplace le message par une chaîne vide si on l'omet — poster que le statut
 * effacerait donc le texte, et inversement.
 */
export function saveStatus(
  client: ClientRest,
  valeurs: { status: DefaultStatus; message: string },
): Promise<void> {
  return client
    .post('users.setStatus', {
      body: { status: valeurs.status, message: valeurs.message },
      networkReplay: true,
    })
    .then(() => undefined);
}

/** Champs de `users.updateOwnBasicInfo`. `currentPassword` = SHA-256 du mdp. */
export type BasicInfo = {
  name?: string;
  username?: string;
  email?: string;
  bio?: string;
  currentPassword?: string;
};

export function saveBasicInfo(
  client: ClientRest,
  data: BasicInfo,
  deuxFacteurs?: TwoFactorCode,
): Promise<void> {
  return client
    .post('users.updateOwnBasicInfo', { body: { data }, twoFactor: deuxFacteurs, networkReplay: true })
    .then(() => undefined);
}

/**
 * Ne retient que les champs de base réellement modifiés (hors mot de passe, qui
 * n'est pas dans le profil lu). Un `updateOwnBasicInfo` vide est inutile — et
 * renvoyer l'e-mail inchangé relancerait une vérification côté serveur.
 */
export function diffInfos(initial: MyProfile, courant: MyProfile): BasicInfo {
  const d: BasicInfo = {};
  if (courant.name !== initial.name) d.name = courant.name;
  if (courant.username !== initial.username) d.username = courant.username;
  if (courant.email !== initial.email) d.email = courant.email;
  if (courant.bio !== initial.bio) d.bio = courant.bio;
  return d;
}

/** Vrai si le diff touche à l'e-mail ou au nom d'utilisateur → mot de passe requis. */
export function requiresPassword(infos: BasicInfo): boolean {
  return infos.email !== undefined || infos.username !== undefined;
}
