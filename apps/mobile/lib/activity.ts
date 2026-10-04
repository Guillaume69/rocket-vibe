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
export class ActivityEngine {
  private readonly counters = new Map<string, number>();
  private readonly subscribers = new Set<() => void>();

  /**
   * Enveloppe un fetch : allume la portée le temps du travail, l'éteint à la
   * fin — succès COMME échec (`finally`), pour ne jamais laisser un compteur
   * bloqué en l'air. Rejette comme la promesse d'origine : l'appelant (le
   * pilote de reconnexion) garde sa gestion d'erreur intacte.
   */
  async track<T>(key: string, work: Promise<T>): Promise<T> {
    this.adjust(key, 1);
    try {
      return await work;
    } finally {
      this.adjust(key, -1);
    }
  }

  /** `true` tant qu'au moins un fetch est en vol pour cette portée. */
  active(key: string): boolean {
    return (this.counters.get(key) ?? 0) > 0;
  }

  onChange(reread: () => void): () => void {
    this.subscribers.add(reread);
    return () => {
      this.subscribers.delete(reread);
    };
  }

  private adjust(key: string, delta: number): void {
    const before = this.counters.get(key) ?? 0;
    const after = before + delta;
    if (after <= 0) this.counters.delete(key);
    else this.counters.set(key, after);
    // Ne notifier que si l'état BOOLÉEN de la portée a basculé : un second
    // fetch concurrent (1→2, 2→1) ne re-rend personne — seuls comptent
    // l'allumage (0→1) et l'extinction (1→0).
    if (before > 0 !== after > 0) {
      for (const reread of this.subscribers) reread();
    }
  }
}
