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

export type ReconnectOptions = {
  /** La tentative complète : connexion + login. Rejette = on retentera. */
  connect: () => Promise<void>;
  minDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (m: ReturnType<typeof setTimeout>) => void;
};

export class Reconnector {
  private readonly connect: () => Promise<void>;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (m: ReturnType<typeof setTimeout>) => void;

  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private rerunRequested = false;
  private stopped = false;
  /** Réversible, contrairement à `arrete` : le temps d'un passage en fond. */
  private suspended = false;

  constructor(options: ReconnectOptions) {
    this.connect = options.connect;
    this.minDelayMs = options.minDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelTimer = options.cancel ?? ((m) => clearTimeout(m));
  }

  /** Prochain délai : 0 pour la première tentative, puis 1 s, 2 s… plafonné à 30 s. */
  private delay(): number {
    if (this.attempt === 0) return 0;
    const full = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** (this.attempt - 1));
    return full / 2 + this.random() * (full / 2);
  }

  /**
   * Demande une (re)connexion. Sans effet si une tentative est déjà prévue —
   * et si une tentative est EN VOL, la demande est mémorisée puis rejouée à
   * la fin : une perte de socket qui survient pendant une tentative « réussie »
   * (la socket retombe pendant le rechargement REST) serait sinon avalée, et
   * plus rien ne reconnecterait jamais.
   */
  trigger(): void {
    if (this.stopped || this.suspended || this.timer !== null) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.tryConnect();
    }, this.delay());
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    this.inFlight = true;
    this.rerunRequested = false;
    try {
      await this.connect();
      this.attempt = 0;
    } catch {
      this.attempt++;
      this.inFlight = false;
      this.trigger();
      return;
    }
    this.inFlight = false;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.trigger();
    }
  }

  /** À la déconnexion ou au démontage : plus aucune tentative ne partira. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Le temps d'un passage en arrière-plan. Contrairement à `arreter()`, c'est
   * réversible — et ça ferme les DEUX chemins qui rouvraient une socket en
   * fond : la minuterie déjà armée, qu'on désarme ici, et la relance que
   * l'échec (ou la mémorisation) d'une tentative en vol demanderait ensuite,
   * que le drapeau bloque dans `declencher()`.
   *
   * Chaque tentative en fond coûte une socket que Doze tuera — ce qui
   * redéclenche `surPerte` — et un `rattraperTout()` REST rate-limité.
   */
  suspend(): void {
    this.suspended = true;
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Au retour au premier plan. Le backoff accumulé décrit un réseau observé
   * écran éteint : on le remet à zéro pour que la tentative suivante parte
   * tout de suite. Sans quoi le retour d'un utilisateur — un geste, donc une
   * cadence bornée par lui — se paierait jusqu'à trente secondes d'attente.
   *
   * Ne ressuscite pas un pilote `arreter()` : ce chemin-là est définitif.
   */
  resume(): void {
    this.suspended = false;
    this.attempt = 0;
  }
}
