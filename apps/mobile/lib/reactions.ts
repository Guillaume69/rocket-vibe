/**
 * Les réactions d'un message, projetées pour le rendu.
 *
 * La colonne `messages.reactions` porte le JSON du serveur tel quel :
 * `{":+1:": {"usernames": ["alice","bob"], "names": [...]}}` — les clés sont
 * des codes courts ENTRE deux-points, et l'appartenance se juge au USERNAME
 * (pas à l'uid : le serveur ne stocke que les pseudos). Cette colonne était
 * écrite depuis le premier jour (`lib/normalize.ts`) mais lue nulle part :
 * l'utilisateur réagissait, la feuille se fermait, rien ne changeait à
 * l'écran. La projection vit ici, pure et testable ; le rendu des pastilles
 * est dans `ui/messageRow.tsx`.
 */

export type DisplayedReaction = {
  /** Code court SANS les deux-points (`+1`, `party_parrot`). */
  code: string;
  /** Nombre de personnes ayant posé cette réaction. */
  total: number;
  /** Mon username y figure : le contour s'accentue, et le tap RETIRE. */
  byMe: boolean;
};

/**
 * `brut` = la colonne `reactions` (JSON sérialisé, ou null). `moi` = mon
 * username, ou null si inconnu (résultats de recherche) — `parMoi` reste alors
 * faux, les pastilles s'affichent sans être marquées. Tolérant comme tout ce
 * qui vient d'autrui : un JSON illisible ou une forme inattendue rend `[]`,
 * jamais une exception. L'ordre du serveur est préservé.
 */
export function reactionList(raw: string | null, me: string | null): DisplayedReaction[] {
  if (raw === null) return [];
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [];
  const out: DisplayedReaction[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const rawUsernames = (value as { usernames?: unknown } | null)?.usernames;
    const usernames = Array.isArray(rawUsernames)
      ? rawUsernames.filter((u): u is string => typeof u === 'string')
      : [];
    if (usernames.length === 0) continue;
    out.push({
      code: key.replace(/^:/, '').replace(/:$/, ''),
      total: usernames.length,
      byMe: me !== null && usernames.includes(me),
    });
  }
  return out;
}
