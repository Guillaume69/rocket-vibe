/**
 * Authentification Rocket.Chat, 2FA comprise.
 *
 * Le mécanisme 2FA est **générique et mal nommé** : l'erreur `totp-required`
 * couvre aussi bien `totp` que `email` et `password`. La méthode réellement
 * attendue est dans `details.method`. On ne devine pas — on lit.
 *
 * Pour la méthode `password`, le code attendu est le **SHA-256 hexadécimal du
 * mot de passe**, jamais le mot de passe en clair. Vérifié contre un serveur
 * 8.5 réel en modifiant un réglage privilégié.
 *
 * Comme `ClientRest`, ce module n'importe pas `react-native` : le hachage est
 * injecté (`expo-crypto` dans l'app, `node:crypto` dans les tests).
 */

import type { Genre } from './provider.ts';
import { ClientRest, ErreurDeuxFacteurs, type CodeDeuxFacteurs } from './rest.ts';

export type Session = {
  baseUrl: string;
  authToken: string;
  userId: string;
  username: string;
  /** Type de serveur : décide quel driver instancier. Ici toujours `rocketchat`. */
  genre: Genre;
  /**
   * `Site_Url` du serveur, relevé au sondage de connexion. C'est la SEULE URL
   * que le serveur reconnaît en tête d'un permalien de citation
   * (`lib/quote.ts`) — `baseUrl` peut en différer (alias de proxy, IP, port,
   * http/https : cas du banc émulateur, `10.0.2.2:3300` vs `localhost:3300`).
   * `null` pour une session d'avant le champ ou un réglage absent : on retombe
   * alors sur `baseUrl`, le comportement historique.
   */
  siteUrl: string | null;
};

/** SHA-256 hexadécimal, en minuscules. */
export type Hacheur = (texte: string) => Promise<string>;

export type Credentials = {
  utilisateur: string;
  motDePasse: string;
};

type ReponseLogin = {
  status?: string;
  data: {
    authToken: string;
    userId: string;
    me: { username: string };
  };
};

/**
 * Transforme un code saisi par l'utilisateur en code accepté par le serveur.
 *
 * - `totp` et `email` : le code est envoyé tel quel.
 * - `password` : c'est le mot de passe qu'il faut hacher, pas le code saisi.
 */
export async function preparerCodeDeuxFacteurs(
  erreur: ErreurDeuxFacteurs,
  saisie: string,
  hacher: Hacheur,
): Promise<CodeDeuxFacteurs> {
  if (erreur.methode === 'password') {
    return { methode: 'password', code: await hacher(saisie) };
  }
  return { methode: erreur.methode, code: saisie.trim() };
}

/**
 * Ouvre une session. Lève `ErreurDeuxFacteurs` si le serveur exige un second
 * facteur : l'appelant affiche la bonne UI selon `erreur.methode`, puis rappelle
 * `seConnecter` avec le code préparé.
 */
export async function seConnecter(
  client: ClientRest,
  credentials: Credentials,
  deuxFacteurs?: CodeDeuxFacteurs,
): Promise<Session> {
  const reponse = await client.post<ReponseLogin>('login', {
    anonyme: true,
    deuxFacteurs,
    corps: { user: credentials.utilisateur, password: credentials.motDePasse },
  });
  return sessionDepuis(client.baseUrl, reponse);
}

/**
 * Reprend une session à partir d'un jeton stocké. Le même jeton sert au REST
 * **et** au WebSocket : le spike DDP l'a vérifié, `method login {resume}`
 * l'accepte tel quel.
 */
export async function reprendreSession(client: ClientRest, authToken: string): Promise<Session> {
  const reponse = await client.post<ReponseLogin>('login', {
    anonyme: true,
    corps: { resume: authToken },
  });
  return sessionDepuis(client.baseUrl, reponse);
}

class ErreurLogin extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurLogin';
  }
}

/**
 * `ClientRest` traite un 200 au corps vide comme un succès — nécessaire pour
 * `/logout`. Un `/login` répondant ainsi donnerait `reponse.data === undefined`
 * et une `TypeError` brute : on garde donc avant de déstructurer.
 */
function sessionDepuis(baseUrl: string, reponse: ReponseLogin | undefined): Session {
  const donnees = reponse?.data;
  if (!donnees?.authToken || !donnees.userId) {
    throw new ErreurLogin('Réponse de login invalide : ni jeton ni identifiant.');
  }
  return {
    baseUrl,
    authToken: donnees.authToken,
    userId: donnees.userId,
    username: donnees.me?.username ?? '',
    genre: 'rocketchat',
    // `/login` ne connaît pas `Site_Url` : c'est l'écran de connexion qui le
    // complète depuis son sondage (`ProfilServeur.siteUrl`) avant de persister.
    // La validation de reprise (`ui/session.tsx`) ne lit que `username` de ce
    // retour — le `siteUrl` persisté n'est jamais écrasé par ce null.
    siteUrl: null,
  };
}

/**
 * Demande l'envoi d'un code par email. `codeGenerated: false` dans l'erreur 2FA
 * signifie qu'aucun code n'est encore parti : il faut appeler ceci d'abord.
 *
 * Ne prend que l'identifiant : exiger `Credentials` obligerait à garder le mot
 * de passe en mémoire pour rien.
 */
export function demanderCodeParEmail(client: ClientRest, emailOuNom: string): Promise<void> {
  return client
    .post('users.2fa.sendEmailCode', { anonyme: true, corps: { emailOrUsername: emailOuNom } })
    .then(() => undefined);
}

/**
 * Le logout est **best-effort**. Un jeton déjà expiré fait répondre 401, mais
 * l'utilisateur est de fait déconnecté : propager l'erreur ferait afficher un
 * échec alors que la session locale est effacée.
 */
/**
 * Rend **vrai si le serveur a bien fermé la session**, faux si l'appel n'a pas
 * abouti. L'appelant s'en sert pour mettre la déconnexion en file plutôt que
 * de la perdre (`lib/deferredLogout.ts`) : hors ligne, le jeton reste
 * vivant côté serveur, et personne ne le savait.
 *
 * L'échec n'est toujours PAS relayé en exception : l'état local est déconnecté
 * quoi qu'il arrive, un serveur injoignable ne doit pas retenir l'utilisateur
 * sur un écran qu'il vient de quitter.
 */
export async function seDeconnecter(client: ClientRest): Promise<boolean> {
  try {
    await client.post('logout');
    return true;
  } catch {
    return false;
  } finally {
    client.identifiants = null;
  }
}

/** Applique la session au client pour les appels suivants. */
export function appliquerSession(client: ClientRest, session: Session): void {
  client.identifiants = { authToken: session.authToken, userId: session.userId };
}
