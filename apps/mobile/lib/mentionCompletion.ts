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
const VALID_USERNAME = /^[A-Za-z0-9._-]*$/;
/**
 * Une lettre ou un chiffre Unicode — accents compris. Le `@` ne doit ouvrir un
 * jeton que s'il commence un mot : au milieu de `nom@domaine` (adresse email),
 * il ne déclenche pas.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Le jeton `@xxx` en cours de frappe juste avant le curseur, ou `null`.
 *
 * Mêmes gardes que `detecterJetonEmoji` : le `@` doit ouvrir un mot (début du
 * champ, ou précédé d'un caractère qui n'est ni lettre ni chiffre), et la
 * requête doit rester dans le jeu de caractères d'un username.
 */
export function detectMentionToken(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const c = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, c);
  const atSign = before.lastIndexOf('@');
  if (atSign === -1) return null;
  // `charAt` renvoie '' hors bornes : pas de garde d'index nécessaire.
  if (atSign > 0 && LETTER_OR_DIGIT.test(before.charAt(atSign - 1))) return null;
  const query = before.slice(atSign + 1);
  if (!VALID_USERNAME.test(query) || query.length < MIN_MENTION_QUERY) return null;
  return { start: atSign, query: query.toLowerCase() };
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
  query: string,
  candidates: readonly MentionCandidate[],
  limit = MENTION_SUGGESTION_LIMIT,
): MentionCandidate[] {
  const q = query.toLowerCase();

  const kept: { c: MentionCandidate; rank: number; order: number }[] = [];
  const seen = new Set<string>();
  const add = (c: MentionCandidate, special: boolean): void => {
    const name = c.username.toLowerCase();
    if (seen.has(name)) return;
    const i = q === '' ? 0 : name.indexOf(q);
    if (i === -1) return;
    const match = q === '' ? 2 : name === q ? 0 : i === 0 ? 1 : 2;
    seen.add(name);
    kept.push({ c, rank: match * 2 + (special ? 1 : 0), order: kept.length });
  };

  for (const c of candidates) add(c, false);
  for (const name of SPECIAL_MENTIONS) add({ username: name, uid: null }, true);

  // Tri STABLE requis (l'ordre d'arrivée départage) : garanti par ECMAScript
  // depuis ES2019, mais `ordre` le rend explicite et indépendant du moteur.
  kept.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return kept.slice(0, limit).map((x) => x.c);
}
