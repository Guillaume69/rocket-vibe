/**
 * Suivi de l'activité réseau de fond, pour l'indicateur « mise à jour… ».
 *
 * Le raccordement — rattrapage global à l'ouverture, historique d'un salon à
 * son ouverture — part en tir-et-oublie (voir `ui/sync.tsx`) : le cache
 * s'affiche aussitôt, mais RIEN ne dit qu'un fetch le rafraîchit. Ce magasin
 * volatil compte les fetches EN VOL par portée (`'global'`, ou un `rid`) ;
 * l'UI le lit via `useSyncExternalStore` (`ui/activity.ts`), comme la présence.
 *
 * Un COMPTEUR, pas un booléen : deux fetches concurrents sur la même portée
 * (le rattrapage d'un salon pendant que son historique se charge) ne doivent
 * pas s'éteindre l'un l'autre — la portée reste allumée tant qu'il en reste un.
 */
export class MoteurActivite {
  private readonly compteurs = new Map<string, number>();
  private readonly abonnes = new Set<() => void>();

  /**
   * Enveloppe un fetch : allume la portée le temps du travail, l'éteint à la
   * fin — succès COMME échec (`finally`), pour ne jamais laisser un compteur
   * bloqué en l'air. Rejette comme la promesse d'origine : l'appelant (le
   * pilote de reconnexion) garde sa gestion d'erreur intacte.
   */
  async suivre<T>(cle: string, travail: Promise<T>): Promise<T> {
    this.ajuster(cle, 1);
    try {
      return await travail;
    } finally {
      this.ajuster(cle, -1);
    }
  }

  /** `true` tant qu'au moins un fetch est en vol pour cette portée. */
  actif(cle: string): boolean {
    return (this.compteurs.get(cle) ?? 0) > 0;
  }

  surChangement(relire: () => void): () => void {
    this.abonnes.add(relire);
    return () => {
      this.abonnes.delete(relire);
    };
  }

  private ajuster(cle: string, delta: number): void {
    const avant = this.compteurs.get(cle) ?? 0;
    const apres = avant + delta;
    if (apres <= 0) this.compteurs.delete(cle);
    else this.compteurs.set(cle, apres);
    // Ne notifier que si l'état BOOLÉEN de la portée a basculé : un second
    // fetch concurrent (1→2, 2→1) ne re-rend personne — seuls comptent
    // l'allumage (0→1) et l'extinction (1→0).
    if (avant > 0 !== apres > 0) {
      for (const relire of this.abonnes) relire();
    }
  }
}
