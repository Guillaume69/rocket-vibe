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

import type { DdpEvent } from './ddp.ts';

export const STREAM_NOTIFY_ROOM_TYPING = 'stream-notify-room';
export const TYPING_ACTIVITY = 'user-typing';

const EXPIRATION_MS = 15_000;

type Annulation = unknown;

export class TypingEngine {
  private readonly rid: string;
  private readonly me: string | null;
  private readonly expirationMs: number;
  private readonly schedule: (fn: () => void, ms: number) => Annulation;
  private readonly cancel: (a: Annulation) => void;

  private timers = new Map<string, Annulation>();
  private listeners = new Set<() => void>();
  /** Figé entre deux notifications : `useSyncExternalStore` compare par référence. */
  private snapshot: string[] = [];

  constructor(options: {
    rid: string;
    /** Mon username : ma propre saisie ne s'affiche pas chez moi. */
    me: string | null;
    expirationMs?: number;
    schedule?: (fn: () => void, ms: number) => Annulation;
    cancel?: (a: Annulation) => void;
  }) {
    this.rid = options.rid;
    this.me = options.me;
    this.expirationMs = options.expirationMs ?? EXPIRATION_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((a) => clearTimeout(a as ReturnType<typeof setTimeout>));
  }

  whoIsTyping(): string[] {
    return this.snapshot;
  }

  onChange(ecouteur: () => void): () => void {
    this.listeners.add(ecouteur);
    return () => {
      this.listeners.delete(ecouteur);
    };
  }

  apply(evenement: DdpEvent): void {
    if (
      evenement.collection !== STREAM_NOTIFY_ROOM_TYPING ||
      evenement.eventKey !== `${this.rid}/user-activity`
    ) {
      return;
    }
    const username = evenement.args[0];
    const activites = evenement.args[1];
    if (typeof username !== 'string' || username === '' || username === this.me) return;
    const tape = Array.isArray(activites) && activites.includes(TYPING_ACTIVITY);

    const existante = this.timers.get(username);
    if (existante !== undefined) this.cancel(existante);

    if (tape) {
      this.timers.set(
        username,
        this.schedule(() => {
          this.timers.delete(username);
          this.notifier();
        }, this.expirationMs),
      );
    } else {
      this.timers.delete(username);
    }
    this.notifier();
  }

  /** À la fermeture de l'écran : plus aucune minuterie ne doit survivre. */
  stop(): void {
    for (const minuterie of this.timers.values()) this.cancel(minuterie);
    this.timers.clear();
    this.snapshot = [];
  }

  private notifier(): void {
    const nouveau = [...this.timers.keys()].sort();
    // Ne notifier QUE sur changement réel : Rocket.Chat ré-émet
    // « user-typing » en battement de cœur pendant toute la frappe — chaque
    // battement re-rendrait sinon l'écran salon entier pour rien.
    if (
      nouveau.length === this.snapshot.length &&
      nouveau.every((nom, i) => nom === this.snapshot[i])
    ) {
      return;
    }
    this.snapshot = nouveau;
    for (const ecouteur of this.listeners) ecouteur();
  }
}

/**
 * La projection d'affichage : un nom, deux noms, ou le compte seul. La mise en
 * PHRASE appartient au catalogue (`salon.saisieUn/Deux/N`, ui/messages.ts) —
 * ce module, pur et testé sous Node, n'embarque aucune langue.
 */
export type TypingSummary =
  | { forme: 'one'; name: string }
  | { forme: 'two'; a: string; b: string }
  | { forme: 'many'; n: number };

/** null si personne n'écrit. */
export function summarizeTyping(noms: string[]): TypingSummary | null {
  if (noms.length === 0) return null;
  if (noms.length === 1) return { forme: 'one', name: noms[0] };
  if (noms.length === 2) return { forme: 'two', a: noms[0], b: noms[1] };
  return { forme: 'many', n: noms.length };
}
