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

type Cancellation = unknown;

export class TypingEngine {
  private readonly rid: string;
  private readonly me: string | null;
  private readonly expirationMs: number;
  private readonly schedule: (fn: () => void, ms: number) => Cancellation;
  private readonly cancel: (a: Cancellation) => void;

  private timers = new Map<string, Cancellation>();
  private listeners = new Set<() => void>();
  /** Figé entre deux notifications : `useSyncExternalStore` compare par référence. */
  private snapshot: string[] = [];

  constructor(options: {
    rid: string;
    /** Mon username : ma propre saisie ne s'affiche pas chez moi. */
    me: string | null;
    expirationMs?: number;
    schedule?: (fn: () => void, ms: number) => Cancellation;
    cancel?: (a: Cancellation) => void;
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

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  apply(event: DdpEvent): void {
    if (
      event.collection !== STREAM_NOTIFY_ROOM_TYPING ||
      event.eventKey !== `${this.rid}/user-activity`
    ) {
      return;
    }
    const username = event.args[0];
    const activities = event.args[1];
    if (typeof username !== 'string' || username === '' || username === this.me) return;
    const typing = Array.isArray(activities) && activities.includes(TYPING_ACTIVITY);

    const existing = this.timers.get(username);
    if (existing !== undefined) this.cancel(existing);

    if (typing) {
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
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.snapshot = [];
  }

  private notifier(): void {
    const next = [...this.timers.keys()].sort();
    // Ne notifier QUE sur changement réel : Rocket.Chat ré-émet
    // « user-typing » en battement de cœur pendant toute la frappe — chaque
    // battement re-rendrait sinon l'écran salon entier pour rien.
    if (
      next.length === this.snapshot.length &&
      next.every((name, i) => name === this.snapshot[i])
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * La projection d'affichage : un nom, deux noms, ou le compte seul. La mise en
 * PHRASE appartient au catalogue (`salon.saisieUn/Deux/N`, ui/messages.ts) —
 * ce module, pur et testé sous Node, n'embarque aucune langue.
 */
export type TypingSummary =
  | { form: 'one'; name: string }
  | { form: 'two'; a: string; b: string }
  | { form: 'many'; n: number };

/** null si personne n'écrit. */
export function summarizeTyping(names: string[]): TypingSummary | null {
  if (names.length === 0) return null;
  if (names.length === 1) return { form: 'one', name: names[0] };
  if (names.length === 2) return { form: 'two', a: names[0], b: names[1] };
  return { form: 'many', n: names.length };
}
