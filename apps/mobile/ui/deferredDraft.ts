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
  save(text: string): void;
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

type Dependencies = {
  /** Écrit le brouillon (texte non blanc) sous la clé liée à l'instance. */
  write: (text: string) => void;
  /** Supprime le brouillon : un texte BLANC vaut suppression, pas écriture. */
  delete: () => void;
  timeoutMs?: number;
  /** Horloge injectable — `setTimeout`/`clearTimeout` par défaut. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export function createDeferredDraft(dep: Dependencies): DeferredDraft {
  const timeoutMs = dep.timeoutMs ?? DRAFT_DELAY_MS;
  const schedule = dep.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    dep.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  /** Le texte tapé mais pas encore écrit — la matière du flush. */
  let paused: string | null = null;

  const set = (text: string): void => {
    if (text.trim() === '') dep.delete();
    else dep.write(text);
  };

  return {
    save(text) {
      paused = text;
      if (timer !== null) cancel(timer);
      timer = schedule(() => {
        // Remise à zéro AVANT l'écriture : un flush qui suivrait le tir ne
        // doit pas rejouer un texte déjà parti. Redondant avec le garde
        // `minuterie === null` de `flusher` — c'est voulu, chacun des deux
        // suffit seul, et la preuve par retrait doit les retirer ENSEMBLE.
        timer = null;
        paused = null;
        set(text);
      }, timeoutMs);
    },

    clear() {
      if (timer !== null) cancel(timer);
      timer = null;
      paused = null;
      set('');
    },

    flusher() {
      if (timer === null) return;
      cancel(timer);
      timer = null;
      if (paused !== null) set(paused);
      paused = null;
    },
  };
}
