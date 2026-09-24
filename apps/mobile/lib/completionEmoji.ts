/**
 * Autocomplétion des codes courts d'emoji dans le composer.
 *
 * Quand on tape `:te`, on veut voir `:test:`, `:tete:`… et pouvoir en choisir
 * un. Trois responsabilités PURES, sans React ni réseau — donc testables sous
 * Node :
 *
 *   1. `detecterJetonEmoji` — repérer le jeton `:xxx` en cours de frappe juste
 *      avant le curseur (et refuser un `http://`, `12:34`, un jeton déjà fermé).
 *   2. `completerEmoji` — classer les codes courts (standard + custom) qui
 *      correspondent à la requête.
 *   3. `appliquerCompletion` — remplacer le jeton par l'insertion choisie.
 *
 * L'insertion elle-même (glyphe Unicode pour un standard, `:nom:` pour un
 * custom) et l'aperçu se résolvent côté UI (`ui/completionEmoji.tsx`), qui a
 * accès à `unicodeDeCodeCourt` et `urlEmojiCustom`. Ici, on ne manipule que des
 * noms — la donnée que ces deux mondes partagent.
 */

/**
 * Dès la PREMIÈRE lettre après `:` on propose — comme Slack/Discord. `:a`
 * matche des centaines d'emojis, mais le classement (exact, préfixe, sous-chaîne)
 * remonte les bons en tête et `LIMITE_SUGGESTIONS` borne la bande. En deçà (le
 * `:` seul), rien : ce serait tout le dictionnaire.
 */
export const MIN_REQUETE = 1;
/** Plafond de suggestions montrées : la bande défile, inutile d'en classer 2000. */
export const LIMITE_SUGGESTIONS = 30;

export type TypeEmoji = 'standard' | 'custom';
export type SuggestionEmoji = { code: string; type: TypeEmoji };

/** Un code court n'est fait que de ces caractères (`+1`, `-1`, `party_parrot`…). */
const CODE_VALIDE = /^[A-Za-z0-9_+-]*$/;
/**
 * Une lettre ou un chiffre Unicode — accents COMPRIS. Le `:` ne doit ouvrir un
 * jeton que s'il commence un mot ; `é`, `à`… sont des lettres au même titre que
 * `a`. Sans `\p{L}`, `résumé:tl` (sans espace) ouvrirait le bandeau à tort.
 */
const LETTRE_OU_CHIFFRE = /[\p{L}\p{N}]/u;

/**
 * Le jeton `:xxx` en cours de frappe juste avant le curseur, ou `null`.
 *
 * Le `:` doit OUVRIR un mot — début du champ, ou précédé d'un caractère qui
 * n'est ni lettre ni chiffre. Sans cette garde, on déclencherait au beau milieu
 * de `http://`, `12:34`, `clé:valeur`. Un jeton déjà fermé (`:smile:`) ne
 * déclenche pas : `lastIndexOf(':')` tombe alors sur le `:` de clôture et la
 * requête est vide.
 */
export function detecterJetonEmoji(
  texte: string,
  curseur: number,
): { debut: number; requete: string } | null {
  const c = Math.max(0, Math.min(curseur, texte.length));
  const avant = texte.slice(0, c);
  const colon = avant.lastIndexOf(':');
  if (colon === -1) return null;
  // `charAt` renvoie toujours une chaîne ('' hors bornes) : pas de garde d'index.
  if (colon > 0 && LETTRE_OU_CHIFFRE.test(avant.charAt(colon - 1))) return null;
  const requete = avant.slice(colon + 1);
  if (!CODE_VALIDE.test(requete) || requete.length < MIN_REQUETE) return null;
  return { debut: colon, requete: requete.toLowerCase() };
}

// Le `Set` des codes standard est construit UNE fois : `codesEmojiStandard()`
// rend toujours le même tableau (cache figé), donc l'identité suffit à savoir
// qu'il n'a pas changé. Sans ce cache, chaque frappe rebâtissait un `Set` de
// 6222 entrées sur le chemin chaud du composer.
let refStandard: readonly string[] | null = null;
let setStandard: Set<string> | null = null;
function ensembleStandard(codes: readonly string[]): Set<string> {
  if (codes !== refStandard) {
    refStandard = codes;
    setStandard = new Set(codes);
  }
  return setStandard as Set<string>;
}

/**
 * Les codes courts qui correspondent à `requete`, du plus au moins pertinent.
 *
 * Ordre : correspondance exacte, puis préfixe, puis sous-chaîne ; à qualité
 * égale, un custom passe avant un standard (c'est ce que l'utilisateur cherche
 * en priorité), puis le code le plus court, puis l'alphabétique.
 *
 * Casse : la requête est minusculée. Les codes standard le sont tous (table
 * générée), mais un nom custom vient du serveur et peut porter une majuscule —
 * on compare donc les customs en minuscules, tout en gardant le code ORIGINAL
 * (l'URL de l'image se bâtit sur le nom exact).
 *
 * Un custom homonyme d'un standard est ÉCARTÉ (jamais ajouté deux fois) : au
 * rendu, le glyphe Unicode gagne sur l'image custom (`ui/markdown.tsx`), donc
 * la suggestion doit insérer le glyphe — on le traite en standard.
 */
export function completerEmoji(
  requete: string,
  codesStandard: readonly string[],
  codesCustom: readonly string[],
  limite = LIMITE_SUGGESTIONS,
): SuggestionEmoji[] {
  const q = requete.toLowerCase();
  if (q.length < MIN_REQUETE) return [];

  const candidats: { s: SuggestionEmoji; rang: number }[] = [];
  const ajouter = (code: string, type: TypeEmoji): void => {
    // Standard : déjà minuscule. Custom : minusculé pour la comparaison seule.
    const foin = type === 'custom' ? code.toLowerCase() : code;
    const i = foin.indexOf(q);
    if (i === -1) return;
    const correspondance = foin === q ? 0 : i === 0 ? 1 : 2;
    // custom (0) avant standard (1) à correspondance égale.
    const rang = correspondance * 2 + (type === 'custom' ? 0 : 1);
    candidats.push({ s: { code, type }, rang });
  };

  const standard = ensembleStandard(codesStandard);
  for (const code of codesCustom) {
    if (standard.has(code.toLowerCase())) continue; // le glyphe standard l'emporte au rendu
    ajouter(code, 'custom');
  }
  for (const code of codesStandard) ajouter(code, 'standard');

  candidats.sort(
    (a, b) =>
      a.rang - b.rang ||
      a.s.code.length - b.s.code.length ||
      (a.s.code < b.s.code ? -1 : a.s.code > b.s.code ? 1 : 0),
  );
  return candidats.slice(0, limite).map((x) => x.s);
}

/**
 * Remplace le jeton `[debut, curseur)` par `insertion`, curseur juste après.
 *
 * Une espace suit l'insertion pour enchaîner la frappe — SAUF si le texte
 * qui suit commence déjà par une espace (sinon on en aurait deux). Le curseur
 * revient pile après ce qu'on vient d'écrire, jamais dans la suite du texte.
 */
export function appliquerCompletion(
  texte: string,
  debut: number,
  curseur: number,
  insertion: string,
): { texte: string; curseur: number } {
  const c = Math.max(debut, Math.min(curseur, texte.length));
  const avant = texte.slice(0, debut);
  const apres = texte.slice(c);
  const bloc = insertion + (/^\s/.test(apres) ? '' : ' ');
  return { texte: avant + bloc + apres, curseur: (avant + bloc).length };
}
