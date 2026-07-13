/**
 * Client REST Rocket.Chat.
 *
 * Volontairement **sans import de `react-native`** : ce module tourne tel quel
 * sous Node, donc ses tests s'exécutent contre de vrais serveurs HTTP plutôt
 * que contre des mocks. Tout ce qui touche à la plateforme (stockage sécurisé,
 * `Platform.OS`) vit ailleurs.
 *
 * On agit en REST et on écoute en DDP : les appels de méthodes DDP sont
 * dépréciés depuis Rocket.Chat 8.0, avec retrait annoncé en 9.0.
 */

export type Identifiants = {
  authToken: string;
  userId: string;
};

/** Méthodes du mécanisme 2FA générique de Rocket.Chat. */
export type MethodeDeuxFacteurs = 'totp' | 'email' | 'password';

export type CodeDeuxFacteurs = {
  code: string;
  methode: MethodeDeuxFacteurs;
};

export class ErreurRest extends Error {
  readonly statut: number;
  readonly erreur?: string;
  readonly errorType?: string;

  constructor(message: string, statut: number, erreur?: string, errorType?: string) {
    super(message);
    this.name = 'ErreurRest';
    this.statut = statut;
    this.erreur = erreur;
    this.errorType = errorType;
  }
}

/**
 * Levée quand le serveur exige une seconde authentification.
 *
 * Le nom `totp-required` trompe : il couvre aussi `email` et `password`. La
 * méthode réellement attendue est dans `details.method`. Pour `password`, le
 * code est le **SHA-256 du mot de passe**, jamais le mot de passe en clair.
 */
export class ErreurDeuxFacteurs extends ErreurRest {
  readonly methode: MethodeDeuxFacteurs;
  readonly methodesDisponibles: MethodeDeuxFacteurs[];
  readonly codeGenere: boolean;

  constructor(
    methode: MethodeDeuxFacteurs,
    methodesDisponibles: MethodeDeuxFacteurs[],
    codeGenere: boolean,
  ) {
    super(`Double authentification requise (${methode})`, 401, undefined, 'totp-required');
    this.name = 'ErreurDeuxFacteurs';
    this.methode = methode;
    this.methodesDisponibles = methodesDisponibles;
    this.codeGenere = codeGenere;
  }
}

export type OptionsAppel = {
  params?: Record<string, string | number | boolean | undefined>;
  corps?: unknown;
  signal?: AbortSignal;
  deuxFacteurs?: CodeDeuxFacteurs;
  /** Ignorer l'authentification (login, settings.public…). */
  anonyme?: boolean;
  /**
   * Rejouer UNE fois si le `fetch` échoue au niveau réseau (aucune réponse
   * HTTP reçue). Réservé aux écritures idempotentes (profil, statut) : une
   * requête rejetée sans réponse n'a rien délivré, donc la rejouer ne double
   * aucun effet serveur. `chat.sendMessage` NE l'active PAS — sa déduplication
   * vit dans lib/envoi, qui garde la ligne « en-attente » pour un rejeu propre.
   */
  rejeuReseau?: boolean;
};

/** Injectables pour les tests : aucun sommeil réel, aucune horloge réelle. */
export type Dependances = {
  fetch: typeof globalThis.fetch;
  dormir: (ms: number) => Promise<void>;
  maintenant: () => number;
};

const DELAI_MS = 15_000;
const TENTATIVES_429 = 3;
/** Un seul rejeu sur échec réseau : une connexion keep-alive morte repart neuve. */
const TENTATIVES_RESEAU = 1;
const DELAI_REJEU_RESEAU_MS = 400;

type ReponseRocketChat = {
  success?: boolean;
  error?: string;
  errorType?: string;
  message?: string;
  status?: string;
  details?: {
    method?: string;
    availableMethods?: string[];
    codeGenerated?: boolean;
  };
};

const METHODES: readonly MethodeDeuxFacteurs[] = ['totp', 'email', 'password'];

function estMethode(v: unknown): v is MethodeDeuxFacteurs {
  return typeof v === 'string' && (METHODES as readonly string[]).includes(v);
}

/** Même forme que l'`AbortError` de `fetch`, sans dépendre de `DOMException`. */
function erreurAnnulation(): Error {
  const e = new Error('Requête annulée.');
  e.name = 'AbortError';
  return e;
}

export class ClientRest {
  readonly baseUrl: string;
  identifiants: Identifiants | null = null;

  private readonly dep: Dependances;

  constructor(baseUrl: string, dep?: Partial<Dependances>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dep = {
      fetch: dep?.fetch ?? globalThis.fetch.bind(globalThis),
      dormir: dep?.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maintenant: dep?.maintenant ?? (() => Date.now()),
    };
  }

  get<T>(chemin: string, options: OptionsAppel = {}): Promise<T> {
    return this.appeler<T>('GET', chemin, options);
  }

  post<T>(chemin: string, options: OptionsAppel = {}): Promise<T> {
    return this.appeler<T>('POST', chemin, options);
  }

  supprimer<T>(chemin: string, options: OptionsAppel = {}): Promise<T> {
    return this.appeler<T>('DELETE', chemin, options);
  }

  private construireUrl(chemin: string, params: OptionsAppel['params']): string {
    const url = new URL(`${this.baseUrl}/api/v1/${chemin}`);
    for (const [cle, valeur] of Object.entries(params ?? {})) {
      if (valeur !== undefined) url.searchParams.set(cle, String(valeur));
    }
    return url.toString();
  }

  private enTetes(options: OptionsAppel): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!options.anonyme && this.identifiants) {
      h['X-Auth-Token'] = this.identifiants.authToken;
      h['X-User-Id'] = this.identifiants.userId;
    }
    if (options.deuxFacteurs) {
      h['x-2fa-code'] = options.deuxFacteurs.code;
      h['x-2fa-method'] = options.deuxFacteurs.methode;
    }
    return h;
  }

  /**
   * Délai avant nouvelle tentative sur 429. Le serveur donne la date de
   * réinitialisation en epoch ms dans `x-ratelimit-reset` ; à défaut, repli
   * exponentiel. On plafonne : un en-tête aberrant ne doit pas geler l'app.
   */
  private delaiApres429(reponse: Response, tentative: number): number {
    const brut = Number(reponse.headers.get('x-ratelimit-reset'));
    const attente = Number.isFinite(brut) ? brut - this.dep.maintenant() : 0;
    const delai = attente > 0 ? attente + 250 : 1000 * 2 ** tentative;
    return Math.min(delai, 30_000);
  }

  private async appeler<T>(
    methode: 'GET' | 'POST' | 'DELETE',
    chemin: string,
    options: OptionsAppel,
    tentative = 0,
    tentativeReseau = 0,
  ): Promise<T> {
    // Un signal DÉJÀ avorté ne déclenchera jamais `addEventListener`, et la
    // requête partirait quand même : on le teste avant d'ouvrir la connexion.
    // Ni `AbortSignal.throwIfAborted` ni `DOMException` ne sont garantis sous
    // Hermes, d'où l'erreur construite à la main.
    if (options.signal?.aborted) throw erreurAnnulation();

    const controleur = new AbortController();
    let expire = false;
    const minuterie = setTimeout(() => {
      expire = true;
      controleur.abort();
    }, DELAI_MS);
    const relayer = () => controleur.abort();
    options.signal?.addEventListener('abort', relayer);

    let reponse: Response;
    try {
      reponse = await this.dep.fetch(this.construireUrl(chemin, options.params), {
        method: methode,
        headers: this.enTetes(options),
        body: options.corps === undefined ? undefined : JSON.stringify(options.corps),
        signal: controleur.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (!expire) throw e; // Annulation demandée par l'appelant.
        throw new ErreurRest(`${chemin} : pas de réponse en ${DELAI_MS / 1000} s.`, 0);
      }
      // Échec réseau : le `fetch` a rejeté sans réponse HTTP. Sur Android/OkHttp,
      // la PREMIÈRE requête après un temps d'inactivité (ici : le temps de
      // remplir le formulaire) réutilise parfois une connexion keep-alive morte
      // et échoue, là où l'envoi immédiat suivant repart sur une connexion neuve
      // — le classique « ça passe à la 2e fois ». Rien n'ayant été reçu du
      // serveur, la requête n'a (quasi) jamais été délivrée : la rejouer ne
      // double aucun effet, mais on ne le fait que si l'appelant l'a demandé.
      if (options.rejeuReseau && tentativeReseau < TENTATIVES_RESEAU) {
        // Le `finally` ferme minuterie et listener à l'évaluation du `return` ;
        // la récursion en réarme de neufs. Les 400 ms d'attente restent bien en
        // deçà du timeout de 15 s, donc l'ancien timer ne fire pas entre-temps.
        await this.dep.dormir(DELAI_REJEU_RESEAU_MS);
        return this.appeler<T>(methode, chemin, options, tentative, tentativeReseau + 1);
      }
      throw new ErreurRest(`${chemin} : serveur injoignable.`, 0);
    } finally {
      clearTimeout(minuterie);
      options.signal?.removeEventListener('abort', relayer);
    }

    if (reponse.status === 429 && tentative < TENTATIVES_429) {
      const delai = this.delaiApres429(reponse, tentative);
      await reponse.body?.cancel();
      await this.dep.dormir(delai);
      return this.appeler<T>(methode, chemin, options, tentative + 1, tentativeReseau);
    }

    // Lire le texte avant de parser : un reverse proxy peut renvoyer du HTML
    // avec un code 200, et « JSON invalide » n'est pas « serveur injoignable ».
    const texte = await reponse.text();

    // `POST /api/v1/logout` répond 200 avec un corps VIDE — vérifié contre un
    // serveur 8.5. Un succès sans contenu n'est pas une erreur de format.
    if (texte.trim() === '' && reponse.ok) return {} as T;

    let json: ReponseRocketChat & Record<string, unknown>;
    try {
      json = JSON.parse(texte) as typeof json;
    } catch {
      throw new ErreurRest(
        `${chemin} : réponse non JSON (${reponse.status}, ${texte.length} octets).`,
        reponse.status,
      );
    }

    // Rocket.Chat 8.5 signale la 2FA sous DEUX formes selon l'endpoint :
    //   /api/v1/login      -> { error: 'totp-required' }      (sans errorType)
    //   /api/v1/settings/* -> { errorType: 'totp-required' }  (sans error)
    // Vérifié contre un serveur réel. Ne tester que `errorType` laissait la 2FA
    // du login remonter comme une ErreurRest ordinaire.
    if (json.errorType === 'totp-required' || json.error === 'totp-required') {
      const brutes = json.details?.availableMethods ?? [];
      const methodeDemandee = estMethode(json.details?.method) ? json.details.method : 'password';
      throw new ErreurDeuxFacteurs(
        methodeDemandee,
        brutes.filter(estMethode),
        json.details?.codeGenerated === true,
      );
    }

    // Rocket.Chat mélange deux conventions : `success: false` sur /api/v1/* et
    // `status: 'error'` sur /api/v1/login. Les deux valent échec.
    if (!reponse.ok || json.success === false || json.status === 'error') {
      const message = json.error ?? json.message ?? `${chemin} a échoué`;
      throw new ErreurRest(message, reponse.status, json.error, json.errorType);
    }

    return json as T;
  }
}
