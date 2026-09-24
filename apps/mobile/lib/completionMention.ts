/**
 * Autocomplétion des mentions `@xxx` dans le composer.
 *
 * Même architecture que `lib/completionEmoji.ts` : des fonctions PURES, sans
 * React ni réseau, testables sous Node. La détection du jeton et le classement
 * vivent ici ; la source des candidats (les auteurs récents du salon, lus dans
 * la base locale) et l'affichage vivent dans `ui/completionMention.tsx`.
 *
 * L'insertion est du texte brut `@username ` : le serveur re-parse les mentions
 * à l'envoi (champ `md`), il n'y a rien d'autre à transporter. Le remplacement
 * du jeton réutilise `appliquerCompletion` de `lib/completionEmoji.ts` — même
 * mécanique, mêmes bords (espace finale, curseur replacé).
 *
 * Candidats locaux seulement — PAS de `spotlight` REST à chaque frappe : on
 * mentionne presque toujours quelqu'un de la conversation, et le REST est
 * rate-limité (CLAUDE.md). Si le besoin d'élargir apparaît, il se traitera
 * comme un second étage, débouncé, à la façon de `app/recherche.tsx`.
 */

/**
 * Dès `@` seul on propose — contrairement aux emojis, le dictionnaire est la
 * poignée d'auteurs du salon, pas 6000 codes : montrer la liste au `@` nu est
 * le geste Slack/Discord attendu.
 */
export const MIN_REQUETE_MENTION = 0;
/** La bande défile horizontalement ; au-delà, le classement a déjà tranché. */
export const LIMITE_SUGGESTIONS_MENTION = 12;

/**
 * Un candidat à la mention : le `username` exact (c'est lui qu'on insère et
 * qui sert d'avatar), et son `_id` serveur quand on le connaît (`null` pour
 * les mentions spéciales `all` / `here`).
 */
export type CandidatMention = { username: string; uid: string | null };

/**
 * Mentions spéciales de Rocket.Chat. Proposées après les personnes à qualité
 * de correspondance égale : `@a` doit d'abord montrer les Alice du salon,
 * `@all` reste à portée juste derrière.
 */
export const MENTIONS_SPECIALES: readonly string[] = ['all', 'here'];

/**
 * Jeu de caractères d'un username Rocket.Chat (réglage serveur par défaut
 * `UTF8_User_Names_Validation = [0-9a-zA-Z-_.]`). Un caractère hors de ce jeu
 * ferme le jeton — taper `@alice bonjour` ne doit pas garder le bandeau ouvert
 * sur la requête `alice bonjour`.
 */
const USERNAME_VALIDE = /^[A-Za-z0-9._-]*$/;
/**
 * Une lettre ou un chiffre Unicode — accents compris. Le `@` ne doit ouvrir un
 * jeton que s'il commence un mot : au milieu de `nom@domaine` (adresse email),
 * il ne déclenche pas.
 */
const LETTRE_OU_CHIFFRE = /[\p{L}\p{N}]/u;

/**
 * Le jeton `@xxx` en cours de frappe juste avant le curseur, ou `null`.
 *
 * Mêmes gardes que `detecterJetonEmoji` : le `@` doit ouvrir un mot (début du
 * champ, ou précédé d'un caractère qui n'est ni lettre ni chiffre), et la
 * requête doit rester dans le jeu de caractères d'un username.
 */
export function detecterJetonMention(
  texte: string,
  curseur: number,
): { debut: number; requete: string } | null {
  const c = Math.max(0, Math.min(curseur, texte.length));
  const avant = texte.slice(0, c);
  const arobase = avant.lastIndexOf('@');
  if (arobase === -1) return null;
  // `charAt` renvoie '' hors bornes : pas de garde d'index nécessaire.
  if (arobase > 0 && LETTRE_OU_CHIFFRE.test(avant.charAt(arobase - 1))) return null;
  const requete = avant.slice(arobase + 1);
  if (!USERNAME_VALIDE.test(requete) || requete.length < MIN_REQUETE_MENTION) return null;
  return { debut: arobase, requete: requete.toLowerCase() };
}

/**
 * Les candidats qui correspondent à `requete`, du plus au moins pertinent.
 *
 * Ordre : correspondance exacte, puis préfixe, puis sous-chaîne ; à qualité
 * égale, une personne passe avant une mention spéciale, puis l'ordre d'ARRIVÉE
 * des candidats départage — l'appelant les fournit du plus récemment actif au
 * plus ancien, et cette fraîcheur est un meilleur signal que l'alphabet.
 *
 * Requête vide (`@` nu) : tous les candidats dans l'ordre d'arrivée, puis les
 * mentions spéciales.
 */
export function completerMention(
  requete: string,
  candidats: readonly CandidatMention[],
  limite = LIMITE_SUGGESTIONS_MENTION,
): CandidatMention[] {
  const q = requete.toLowerCase();

  const retenus: { c: CandidatMention; rang: number; ordre: number }[] = [];
  const vus = new Set<string>();
  const ajouter = (c: CandidatMention, speciale: boolean): void => {
    const nom = c.username.toLowerCase();
    if (vus.has(nom)) return;
    const i = q === '' ? 0 : nom.indexOf(q);
    if (i === -1) return;
    const correspondance = q === '' ? 2 : nom === q ? 0 : i === 0 ? 1 : 2;
    vus.add(nom);
    retenus.push({ c, rang: correspondance * 2 + (speciale ? 1 : 0), ordre: retenus.length });
  };

  for (const c of candidats) ajouter(c, false);
  for (const nom of MENTIONS_SPECIALES) ajouter({ username: nom, uid: null }, true);

  // Tri STABLE requis (l'ordre d'arrivée départage) : garanti par ECMAScript
  // depuis ES2019, mais `ordre` le rend explicite et indépendant du moteur.
  retenus.sort((a, b) => a.rang - b.rang || a.ordre - b.ordre);
  return retenus.slice(0, limite).map((x) => x.c);
}
