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

import type { ClientRest, CodeDeuxFacteurs } from './rest.ts';

/** Statut CHOISI par l'utilisateur (statusDefault), distinct de la présence live. */
export type StatutDefaut = 'online' | 'away' | 'busy' | 'offline';

export type MonProfil = {
  username: string;
  name: string;
  email: string;
  status: StatutDefaut;
  statusText: string;
  bio: string;
};

const STATUTS: readonly StatutDefaut[] = ['online', 'away', 'busy', 'offline'];

function estStatut(v: unknown): v is StatutDefaut {
  return typeof v === 'string' && (STATUTS as readonly string[]).includes(v);
}

/** Toujours une chaîne : les champs de formulaire ne veulent pas d'`undefined`. */
function chaine(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

type ReponseMe = {
  username?: unknown;
  name?: unknown;
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

export function profilDepuisMe(brut: ReponseMe): MonProfil {
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

export function lireMonProfil(client: ClientRest): Promise<MonProfil> {
  return client.get<ReponseMe>('me').then(profilDepuisMe);
}

/**
 * Présence + texte de statut. On envoie TOUJOURS les deux : `users.setStatus`
 * remplace le message par une chaîne vide si on l'omet — poster que le statut
 * effacerait donc le texte, et inversement.
 */
export function enregistrerStatut(
  client: ClientRest,
  valeurs: { status: StatutDefaut; message: string },
): Promise<void> {
  return client
    .post('users.setStatus', {
      corps: { status: valeurs.status, message: valeurs.message },
      rejeuReseau: true,
    })
    .then(() => undefined);
}

/** Champs de `users.updateOwnBasicInfo`. `currentPassword` = SHA-256 du mdp. */
export type InfosDeBase = {
  name?: string;
  username?: string;
  email?: string;
  bio?: string;
  currentPassword?: string;
};

export function enregistrerInfos(
  client: ClientRest,
  data: InfosDeBase,
  deuxFacteurs?: CodeDeuxFacteurs,
): Promise<void> {
  return client
    .post('users.updateOwnBasicInfo', { corps: { data }, deuxFacteurs, rejeuReseau: true })
    .then(() => undefined);
}

/**
 * Ne retient que les champs de base réellement modifiés (hors mot de passe, qui
 * n'est pas dans le profil lu). Un `updateOwnBasicInfo` vide est inutile — et
 * renvoyer l'e-mail inchangé relancerait une vérification côté serveur.
 */
export function diffInfos(initial: MonProfil, courant: MonProfil): InfosDeBase {
  const d: InfosDeBase = {};
  if (courant.name !== initial.name) d.name = courant.name;
  if (courant.username !== initial.username) d.username = courant.username;
  if (courant.email !== initial.email) d.email = courant.email;
  if (courant.bio !== initial.bio) d.bio = courant.bio;
  return d;
}

/** Vrai si le diff touche à l'e-mail ou au nom d'utilisateur → mot de passe requis. */
export function exigeMotDePasse(infos: InfosDeBase): boolean {
  return infos.email !== undefined || infos.username !== undefined;
}
