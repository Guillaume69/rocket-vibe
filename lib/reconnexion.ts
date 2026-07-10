/**
 * Pilote de reconnexion : backoff exponentiel avec gigue, 1 s → 30 s.
 *
 * La gigue n'est pas décorative : sans elle, tous les clients coupés par le
 * même incident retentent à la même seconde et se marchent dessus (troupeau
 * tonnant). Gigue « égale » : moitié fixe, moitié aléatoire.
 *
 * `declencher()` est volontairement idempotent — la perte de socket, l'échec
 * d'une tentative et un signal externe peuvent tous le demander sans créer de
 * tentatives concurrentes.
 *
 * Pur : l'horloge et l'aléa sont injectés, tout se teste sous Node sans
 * attendre une vraie seconde.
 */

export type OptionsReconnexion = {
  /** La tentative complète : connexion + login. Rejette = on retentera. */
  connecter: () => Promise<void>;
  delaiMinMs?: number;
  delaiMaxMs?: number;
  alea?: () => number;
  programmer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  annuler?: (m: ReturnType<typeof setTimeout>) => void;
};

export class Reconnecteur {
  private readonly connecter: () => Promise<void>;
  private readonly delaiMinMs: number;
  private readonly delaiMaxMs: number;
  private readonly alea: () => number;
  private readonly programmer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly annulerMinuterie: (m: ReturnType<typeof setTimeout>) => void;

  private tentative = 0;
  private minuterie: ReturnType<typeof setTimeout> | null = null;
  private enVol = false;
  private relance = false;
  private arrete = false;

  constructor(options: OptionsReconnexion) {
    this.connecter = options.connecter;
    this.delaiMinMs = options.delaiMinMs ?? 1_000;
    this.delaiMaxMs = options.delaiMaxMs ?? 30_000;
    this.alea = options.alea ?? Math.random;
    this.programmer = options.programmer ?? ((fn, ms) => setTimeout(fn, ms));
    this.annulerMinuterie = options.annuler ?? ((m) => clearTimeout(m));
  }

  /** Prochain délai : 0 pour la première tentative, puis 1 s, 2 s… plafonné à 30 s. */
  private delai(): number {
    if (this.tentative === 0) return 0;
    const plein = Math.min(this.delaiMaxMs, this.delaiMinMs * 2 ** (this.tentative - 1));
    return plein / 2 + this.alea() * (plein / 2);
  }

  /**
   * Demande une (re)connexion. Sans effet si une tentative est déjà prévue —
   * et si une tentative est EN VOL, la demande est mémorisée puis rejouée à
   * la fin : une perte de socket qui survient pendant une tentative « réussie »
   * (la socket retombe pendant le rechargement REST) serait sinon avalée, et
   * plus rien ne reconnecterait jamais.
   */
  declencher(): void {
    if (this.arrete || this.minuterie !== null) return;
    if (this.enVol) {
      this.relance = true;
      return;
    }
    this.minuterie = this.programmer(() => {
      this.minuterie = null;
      void this.essayer();
    }, this.delai());
  }

  private async essayer(): Promise<void> {
    if (this.arrete) return;
    this.enVol = true;
    this.relance = false;
    try {
      await this.connecter();
      this.tentative = 0;
    } catch {
      this.tentative++;
      this.enVol = false;
      this.declencher();
      return;
    }
    this.enVol = false;
    if (this.relance) {
      this.relance = false;
      this.declencher();
    }
  }

  /** À la déconnexion ou au démontage : plus aucune tentative ne partira. */
  arreter(): void {
    this.arrete = true;
    if (this.minuterie !== null) {
      this.annulerMinuterie(this.minuterie);
      this.minuterie = null;
    }
  }
}
