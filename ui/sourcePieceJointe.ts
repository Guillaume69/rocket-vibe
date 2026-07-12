/**
 * Canal impératif entre le composeur d'un salon et la feuille « joindre ».
 *
 * La feuille (`app/joindre.tsx`) est une route formSheet native : elle ne peut
 * pas renvoyer de valeur par `routeur.back()`. Le composeur ARME une demande
 * avant d'ouvrir la feuille, l'attend, et la feuille la RÉSOUT en choisissant
 * une source (puis se ferme). Fermée sans choix → `null`.
 *
 * Une seule demande vit à la fois (l'UI n'ouvre qu'une feuille, et le 📎 est
 * gelé tant qu'une pièce est en attente) ; par sécurité, une nouvelle demande
 * solde la précédente, et `repondreSource` est idempotent — le démontage de la
 * feuille l'appelle après un éventuel choix, sans effet.
 */
export type SourcePieceJointe = 'photo' | 'video' | 'bibliotheque' | 'fichier';

let resolveur: ((source: SourcePieceJointe | null) => void) | null = null;

export function demanderSource(): Promise<SourcePieceJointe | null> {
  resolveur?.(null);
  return new Promise((resolve) => {
    resolveur = resolve;
  });
}

export function repondreSource(source: SourcePieceJointe | null): void {
  const r = resolveur;
  resolveur = null;
  r?.(source);
}
