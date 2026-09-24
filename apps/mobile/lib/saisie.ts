/**
 * Indicateur de saisie (8.6) — ÉCOUTE seule.
 *
 * Le canal est `stream-notify-room` / `<rid>/user-activity` — PAS `/typing`,
 * déprécié. Format vérifié par sonde sur 8.5 :
 * `args = [username, ['user-typing'] | [], extra]` — le tableau vide signifie
 * « a arrêté ».
 *
 * **Écart consigné : on n'ÉMET pas.** L'émission cliente passe par la method
 * DDP du streamer (`stream-notify-room`, vu dans `allowWrite` du bundle
 * serveur) et n'a AUCUN équivalent REST ; notre client DDP est volontairement
 * sans `call` (contrainte projet). Les autres ne voient donc pas notre
 * saisie — à réévaluer si la parité l'exige un jour (ajout borné).
 *
 * Chaque entrée expire d'elle-même : l'événement « stop » d'un correspondant
 * qui perd le réseau ne viendra jamais, et un « écrit… » fantôme est pire
 * que pas d'indicateur.
 */

import type { Evenement } from './ddp.ts';

export const STREAM_NOTIFY_ROOM_SAISIE = 'stream-notify-room';
export const ACTIVITE_SAISIE = 'user-typing';

const EXPIRATION_MS = 15_000;

type Annulation = unknown;

export class MoteurSaisie {
  private readonly rid: string;
  private readonly moi: string | null;
  private readonly expirationMs: number;
  private readonly planifier: (fn: () => void, ms: number) => Annulation;
  private readonly annuler: (a: Annulation) => void;

  private minuteries = new Map<string, Annulation>();
  private ecouteurs = new Set<() => void>();
  /** Figé entre deux notifications : `useSyncExternalStore` compare par référence. */
  private instantane: string[] = [];

  constructor(options: {
    rid: string;
    /** Mon username : ma propre saisie ne s'affiche pas chez moi. */
    moi: string | null;
    expirationMs?: number;
    planifier?: (fn: () => void, ms: number) => Annulation;
    annuler?: (a: Annulation) => void;
  }) {
    this.rid = options.rid;
    this.moi = options.moi;
    this.expirationMs = options.expirationMs ?? EXPIRATION_MS;
    this.planifier = options.planifier ?? ((fn, ms) => setTimeout(fn, ms));
    this.annuler = options.annuler ?? ((a) => clearTimeout(a as ReturnType<typeof setTimeout>));
  }

  quiTape(): string[] {
    return this.instantane;
  }

  surChangement(ecouteur: () => void): () => void {
    this.ecouteurs.add(ecouteur);
    return () => {
      this.ecouteurs.delete(ecouteur);
    };
  }

  appliquer(evenement: Evenement): void {
    if (
      evenement.collection !== STREAM_NOTIFY_ROOM_SAISIE ||
      evenement.cleEvenement !== `${this.rid}/user-activity`
    ) {
      return;
    }
    const username = evenement.args[0];
    const activites = evenement.args[1];
    if (typeof username !== 'string' || username === '' || username === this.moi) return;
    const tape = Array.isArray(activites) && activites.includes(ACTIVITE_SAISIE);

    const existante = this.minuteries.get(username);
    if (existante !== undefined) this.annuler(existante);

    if (tape) {
      this.minuteries.set(
        username,
        this.planifier(() => {
          this.minuteries.delete(username);
          this.notifier();
        }, this.expirationMs),
      );
    } else {
      this.minuteries.delete(username);
    }
    this.notifier();
  }

  /** À la fermeture de l'écran : plus aucune minuterie ne doit survivre. */
  arreter(): void {
    for (const minuterie of this.minuteries.values()) this.annuler(minuterie);
    this.minuteries.clear();
    this.instantane = [];
  }

  private notifier(): void {
    const nouveau = [...this.minuteries.keys()].sort();
    // Ne notifier QUE sur changement réel : Rocket.Chat ré-émet
    // « user-typing » en battement de cœur pendant toute la frappe — chaque
    // battement re-rendrait sinon l'écran salon entier pour rien.
    if (
      nouveau.length === this.instantane.length &&
      nouveau.every((nom, i) => nom === this.instantane[i])
    ) {
      return;
    }
    this.instantane = nouveau;
    for (const ecouteur of this.ecouteurs) ecouteur();
  }
}

/**
 * La projection d'affichage : un nom, deux noms, ou le compte seul. La mise en
 * PHRASE appartient au catalogue (`salon.saisieUn/Deux/N`, ui/messages.ts) —
 * ce module, pur et testé sous Node, n'embarque aucune langue.
 */
export type ResumeSaisie =
  | { forme: 'un'; nom: string }
  | { forme: 'deux'; a: string; b: string }
  | { forme: 'plusieurs'; n: number };

/** null si personne n'écrit. */
export function resumerSaisie(noms: string[]): ResumeSaisie | null {
  if (noms.length === 0) return null;
  if (noms.length === 1) return { forme: 'un', nom: noms[0] };
  if (noms.length === 2) return { forme: 'deux', a: noms[0], b: noms[1] };
  return { forme: 'plusieurs', n: noms.length };
}
