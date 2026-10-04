/**
 * Autocomplétion des mentions `@xxx` dans le composer.
 *
 * Même architecture que `lib/emojiCompletion.ts` : des fonctions PURES, sans
 * React ni réseau, testables sous Node. La détection du jeton et le classement
 * vivent ici ; la source des candidats (les auteurs récents du salon, lus dans
 * la base locale) et l'affichage vivent dans `ui/mentionCompletion.tsx`.
 *
 * L'insertion est du texte brut `@username ` : le serveur re-parse les mentions
 * à l'envoi (champ `md`), il n'y a rien d'autre à transporter. Le remplacement
 * du jeton réutilise `appliquerCompletion` de `lib/emojiCompletion.ts` — même
 * mécanique, mêmes bords (espace finale, curseur replacé).
 *
 * Candidats locaux seulement — PAS de `spotlight` REST à chaque frappe : on
 * mentionne presque toujours quelqu'un de la conversation, et le REST est
 * rate-limité (CLAUDE.md). Si le besoin d'élargir apparaît, il se traitera
 * comme un second étage, débouncé, à la façon de `app/search.tsx`.
 */

/**
 * Dès `@` seul on propose — contrairement aux emojis, le dictionnaire est la
 * poignée d'auteurs du salon, pas 6000 codes : montrer la liste au `@` nu est
 * le geste Slack/Discord attendu.
 */
export const MIN_MENTION_QUERY = 0;
/** La bande défile horizontalement ; au-delà, le classement a déjà tranché. */
export const MENTION_SUGGESTION_LIMIT = 12;

/**
 * Un candidat à la mention : le `username` exact (c'est lui qu'on insère et
 * qui sert d'avatar), et son `_id` serveur quand on le connaît (`null` pour
 * les mentions spéciales `all` / `here`).
 */
export type MentionCandidate = { username: string; uid: string | null };

/**
 * Mentions spéciales de Rocket.Chat. Proposées après les personnes à qualité
 * de correspondance égale : `@a` doit d'abord montrer les Alice du salon,
 * `@all` reste à portée juste derrière.
 */
export const SPECIAL_MENTIONS: readonly string[] = ['all', 'here'];

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
export function detectMentionToken(
  texte: string,
  curseur: number,
): { start: number; query: string } | null {
  const c = Math.max(0, Math.min(curseur, texte.length));
  const avant = texte.slice(0, c);
  const arobase = avant.lastIndexOf('@');
  if (arobase === -1) return null;
  // `charAt` renvoie '' hors bornes : pas de garde d'index nécessaire.
  if (arobase > 0 && LETTRE_OU_CHIFFRE.test(avant.charAt(arobase - 1))) return null;
  const requete = avant.slice(arobase + 1);
  if (!USERNAME_VALIDE.test(requete) || requete.length < MIN_MENTION_QUERY) return null;
  return { start: arobase, query: requete.toLowerCase() };
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
export function completeMention(
  requete: string,
  candidats: readonly MentionCandidate[],
  limite = MENTION_SUGGESTION_LIMIT,
): MentionCandidate[] {
  const q = requete.toLowerCase();

  const retenus: { c: MentionCandidate; rank: number; order: number }[] = [];
  const vus = new Set<string>();
  const ajouter = (c: MentionCandidate, speciale: boolean): void => {
    const nom = c.username.toLowerCase();
    if (vus.has(nom)) return;
    const i = q === '' ? 0 : nom.indexOf(q);
    if (i === -1) return;
    const correspondance = q === '' ? 2 : nom === q ? 0 : i === 0 ? 1 : 2;
    vus.add(nom);
    retenus.push({ c, rank: correspondance * 2 + (speciale ? 1 : 0), order: retenus.length });
  };

  for (const c of candidats) ajouter(c, false);
  for (const nom of SPECIAL_MENTIONS) ajouter({ username: nom, uid: null }, true);

  // Tri STABLE requis (l'ordre d'arrivée départage) : garanti par ECMAScript
  // depuis ES2019, mais `ordre` le rend explicite et indépendant du moteur.
  retenus.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return retenus.slice(0, limite).map((x) => x.c);
}
