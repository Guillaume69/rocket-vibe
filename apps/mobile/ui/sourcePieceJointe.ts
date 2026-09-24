/**
 * Canal impératif entre le composeur d'un salon et la feuille « joindre ».
 *
 * La feuille (`app/joindre.tsx`) est une route formSheet native : elle ne peut
 * pas renvoyer de valeur par `routeur.back()`. Le composeur ARME une demande
 * avant d'ouvrir la feuille, l'attend, et la feuille la RÉSOUT en choisissant
 * une source. Fermée sans choix → `null`.
 *
 * QUI FERME LA FEUILLE, ET QUAND — c'est tout l'enjeu, pas un détail.
 * Longtemps la feuille se fermait elle-même au tap et ne répondait qu'à son
 * démontage ; le composeur lançait donc le sélecteur natif pendant que
 * react-native-screens escamotait encore la feuille. Or Android, au lancement
 * d'une activité, parcourt récursivement l'arbre de vues et déréférence chaque
 * enfant SANS tester sa nullité : une vue retirée en cours de route et tout
 * lancement d'activité échoue — durablement, jusqu'au redémarrage de l'app
 * (`ui/lancerSelecteur.ts` détaille le NPE).
 *
 * Désormais la feuille répond AU TAP, en restant ouverte : au moment du
 * lancement, l'arbre de vues est immobile, il n'y a plus de course à perdre.
 * C'est le composeur qui referme, une fois le sélecteur revenu — d'où
 * `feuilleEstMontee` : sans lui, un `back()` de trop fermerait le SALON quand
 * l'usager a balayé la feuille pendant que le sélecteur s'ouvrait.
 *
 * Ni délai ni pari sur une durée d'animation : on ne ferme jamais AVANT, donc
 * il n'y a rien à attendre.
 *
 * Une seule demande vit à la fois (l'UI n'ouvre qu'une feuille, et le 📎 est
 * gelé tant qu'une pièce est en attente) ; par sécurité, une nouvelle demande
 * solde la précédente, et `repondreSource` est idempotent — le démontage de la
 * feuille l'appelle après un éventuel choix, sans effet.
 */
export type SourcePieceJointe = 'photo' | 'video' | 'bibliotheque' | 'fichier';

let resolveur: ((source: SourcePieceJointe | null) => void) | null = null;
let feuilleMontee = false;

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

/** La feuille s'annonce à son montage. */
export function signalerFeuilleMontee(): void {
  feuilleMontee = true;
}

/**
 * La feuille s'annonce à son démontage — quelle qu'en soit la cause : balayage,
 * retour matériel, ou le `back()` du composeur. Solde une demande restée en
 * attente (feuille fermée sans choix → `null`).
 */
export function signalerFeuilleDemontee(): void {
  feuilleMontee = false;
  repondreSource(null);
}

/** Le composeur n'a le droit de fermer que si la feuille est ENCORE là. */
export function feuilleEstMontee(): boolean {
  return feuilleMontee;
}
