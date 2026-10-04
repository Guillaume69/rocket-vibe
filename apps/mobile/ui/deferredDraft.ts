/**
 * La mécanique différée des brouillons, extraite de `useBrouillon` pour être
 * testable sous Node — horloge injectée, comme `lib/reconnect.ts`.
 *
 * Une instance est LIÉE à une clé de brouillon : ses `ecrire`/`supprimer`
 * visent cette clé et aucune autre. C'est cette liaison qui porte l'invariant
 * du hook « au changement de clé, le texte en pause part sous l'ANCIENNE clé,
 * jamais sous la nouvelle » : le hook crée une instance par clé (`useMemo`) et
 * FLUSHE l'ancienne dans le cleanup de son effet. Avant l'extraction, cet
 * invariant ne tenait qu'à la chaîne de dépendances `[ecrire]` → `[depot,
 * cle]`, qu'aucun test ni type ne verrouillait ; désormais la mécanique est
 * prouvée ici, et la glu restante du hook est du ressort d'`exhaustive-deps`.
 */

export type DeferredDraft = {
  /** À chaque frappe : l'écriture part après la pause, la dernière gagne. */
  save(texte: string): void;
  /** À l'envoi : suppression IMMÉDIATE, frappe en pause comprise. */
  clear(): void;
  /**
   * Au démontage ou au changement de clé : ce qui est en pause part TOUT DE
   * SUITE. Sans rien en pause (déjà écrit, ou jamais tapé), n'écrit rien —
   * flusher deux fois n'écrit pas deux fois.
   */
  flusher(): void;
};

export const DRAFT_DELAY_MS = 400;

type Dependances = {
  /** Écrit le brouillon (texte non blanc) sous la clé liée à l'instance. */
  write: (texte: string) => void;
  /** Supprime le brouillon : un texte BLANC vaut suppression, pas écriture. */
  delete: () => void;
  timeoutMs?: number;
  /** Horloge injectable — `setTimeout`/`clearTimeout` par défaut. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (minuterie: unknown) => void;
};

export function createDeferredDraft(dep: Dependances): DeferredDraft {
  const delaiMs = dep.timeoutMs ?? DRAFT_DELAY_MS;
  const programmer = dep.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const annuler =
    dep.cancel ?? ((minuterie: unknown) => clearTimeout(minuterie as ReturnType<typeof setTimeout>));

  let minuterie: unknown = null;
  /** Le texte tapé mais pas encore écrit — la matière du flush. */
  let enPause: string | null = null;

  const poser = (texte: string): void => {
    if (texte.trim() === '') dep.delete();
    else dep.write(texte);
  };

  return {
    save(texte) {
      enPause = texte;
      if (minuterie !== null) annuler(minuterie);
      minuterie = programmer(() => {
        // Remise à zéro AVANT l'écriture : un flush qui suivrait le tir ne
        // doit pas rejouer un texte déjà parti. Redondant avec le garde
        // `minuterie === null` de `flusher` — c'est voulu, chacun des deux
        // suffit seul, et la preuve par retrait doit les retirer ENSEMBLE.
        minuterie = null;
        enPause = null;
        poser(texte);
      }, delaiMs);
    },

    clear() {
      if (minuterie !== null) annuler(minuterie);
      minuterie = null;
      enPause = null;
      poser('');
    },

    flusher() {
      if (minuterie === null) return;
      annuler(minuterie);
      minuterie = null;
      if (enPause !== null) poser(enPause);
      enPause = null;
    },
  };
}
