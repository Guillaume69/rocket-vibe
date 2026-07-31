/**
 * Les réactions d'un message, projetées pour le rendu.
 *
 * La colonne `messages.reactions` porte le JSON du serveur tel quel :
 * `{":+1:": {"usernames": ["alice","bob"], "names": [...]}}` — les clés sont
 * des codes courts ENTRE deux-points, et l'appartenance se juge au USERNAME
 * (pas à l'uid : le serveur ne stocke que les pseudos). Cette colonne était
 * écrite depuis le premier jour (`lib/normaliser.ts`) mais lue nulle part :
 * l'utilisateur réagissait, la feuille se fermait, rien ne changeait à
 * l'écran. La projection vit ici, pure et testable ; le rendu des pastilles
 * est dans `ui/ligneMessage.tsx`.
 */

export type ReactionAffichee = {
  /** Code court SANS les deux-points (`+1`, `party_parrot`). */
  code: string;
  /** Nombre de personnes ayant posé cette réaction. */
  total: number;
  /** Mon username y figure : le contour s'accentue, et le tap RETIRE. */
  parMoi: boolean;
};

/**
 * `brut` = la colonne `reactions` (JSON sérialisé, ou null). `moi` = mon
 * username, ou null si inconnu (résultats de recherche) — `parMoi` reste alors
 * faux, les pastilles s'affichent sans être marquées. Tolérant comme tout ce
 * qui vient d'autrui : un JSON illisible ou une forme inattendue rend `[]`,
 * jamais une exception. L'ordre du serveur est préservé.
 */
export function listeReactions(brut: string | null, moi: string | null): ReactionAffichee[] {
  if (brut === null) return [];
  let racine: unknown;
  try {
    racine = JSON.parse(brut);
  } catch {
    return [];
  }
  if (typeof racine !== 'object' || racine === null || Array.isArray(racine)) return [];
  const sorties: ReactionAffichee[] = [];
  for (const [cle, valeur] of Object.entries(racine as Record<string, unknown>)) {
    const brutUsernames = (valeur as { usernames?: unknown } | null)?.usernames;
    const usernames = Array.isArray(brutUsernames)
      ? brutUsernames.filter((u): u is string => typeof u === 'string')
      : [];
    if (usernames.length === 0) continue;
    sorties.push({
      code: cle.replace(/^:/, '').replace(/:$/, ''),
      total: usernames.length,
      parMoi: moi !== null && usernames.includes(moi),
    });
  }
  return sorties;
}
