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

export type RestAuth = {
  authToken: string;
  userId: string;
};

/** Méthodes du mécanisme 2FA générique de Rocket.Chat. */
export type TwoFactorMethod = 'totp' | 'email' | 'password';

export type TwoFactorCode = {
  code: string;
  method: TwoFactorMethod;
};

export class RestError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly errorType?: string;
  /**
   * Le corps a été lu comme une réponse **Rocket.Chat** (enveloppe
   * `success`/`error`), et non comme une page opaque.
   *
   * C'est ce qui sépare « le serveur applicatif nous répond » de « quelque
   * chose sur le chemin nous répond » : un proxy d'entreprise, un portail
   * captif ou un ballast de maintenance peut rendre un 401 en HTML. Son statut
   * est le SIEN — il ne dit rien de notre jeton, et le prendre pour une
   * révocation éjecterait l'utilisateur d'une session parfaitement valide.
   */
  readonly understoodResponse: boolean;

  constructor(
    message: string,
    status: number,
    error?: string,
    errorType?: string,
    understoodResponse = false,
  ) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.error = error;
    this.errorType = errorType;
    this.understoodResponse = understoodResponse;
  }
}

/**
 * Levée quand le serveur exige une seconde authentification.
 *
 * Le nom `totp-required` trompe : il couvre aussi `email` et `password`. La
 * méthode réellement attendue est dans `details.method`. Pour `password`, le
 * code est le **SHA-256 du mot de passe**, jamais le mot de passe en clair.
 */
export class TwoFactorError extends RestError {
  readonly method: TwoFactorMethod;
  readonly availableMethods: TwoFactorMethod[];
  readonly generatedCode: boolean;

  constructor(
    method: TwoFactorMethod,
    availableMethods: TwoFactorMethod[],
    generatedCode: boolean,
  ) {
    // `reponseComprise` vaut bien TRUE : un défi 2FA est une réponse
    // Rocket.Chat en bonne et due forme, lue comme telle. Ce qui l'écarte
    // d'une révocation est son TYPE, pas un défaut de lecture — et c'est ce
    // qui rend la garde `instanceof` du prédicat portante plutôt que
    // décorative. Le 401 déclaré ici, lui, ne reflète pas le statut HTTP :
    // hors login, 8.5 répond 400.
    super(`Two-factor authentication required (${method})`, 401, undefined, 'totp-required', true);
    this.name = 'TwoFactorError';
    this.method = method;
    this.availableMethods = availableMethods;
    this.generatedCode = generatedCode;
  }
}

/**
 * « Le serveur a-t-il refusé CE jeton ? »
 *
 * Le seul prédicat autorisé à déclencher une déconnexion automatique. Il est
 * volontairement le plus étroit possible : une erreur de discrimination éjecte
 * l'utilisateur d'une session saine, ce qui est pire que le défaut qu'on
 * corrige.
 *
 * Sondé contre un Rocket.Chat 8.5 (banc local, 30/07/2026), le serveur est net
 * — **401 veut dire « non authentifié », et rien d'autre** :
 *
 * | situation                                   | réponse |
 * |---------------------------------------------|---------|
 * | jeton révoqué par `logout`                  | **401** `You must be logged in to do this.` |
 * | jeton absent, jeton bidon, uid bidon        | **401**, corps identique |
 * | permission manquante (route admin)          | 403 `error-unauthorized` |
 * | exclu du salon, salon inexistant            | 400 `error-not-allowed` / `error-room-not-found` |
 * | 2FA exigée sur une opération sensible       | 400 `totp-required` |
 *
 * D'où les trois conditions, chacune fermant un faux positif réel :
 *
 * 1. `ErreurRest` de statut 401 — le cas nominal ;
 * 2. **pas** une `ErreurDeuxFacteurs` : elle se déclare 401 quelle que soit la
 *    réponse HTTP (le serveur répond 400 hors login), et c'est un défi, pas un
 *    refus. La traiter en révocation déconnecterait quiconque change son mot
 *    de passe ;
 * 3. `reponseComprise` : un 401 dont le corps n'est pas du Rocket.Chat vient
 *    d'un intermédiaire, pas du serveur.
 *
 * Ce que le prédicat NE dit pas : si ce jeton est encore celui de la session
 * affichée. Cette comparaison appartient à l'appelant, qui seul connaît le
 * jeton réellement envoyé (voir `surJetonRefuse`).
 */
export function isTokenRejected(e: unknown): boolean {
  if (e instanceof TwoFactorError) return false;
  if (!(e instanceof RestError)) return false;
  return e.status === 401 && e.understoodResponse;
}

export type RequestOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  twoFactor?: TwoFactorCode;
  /** Ignorer l'authentification (login, settings.public…). */
  anonymous?: boolean;
  /**
   * Rejouer UNE fois si le `fetch` échoue au niveau réseau (aucune réponse
   * HTTP reçue). Réservé aux écritures idempotentes (profil, statut) : une
   * requête rejetée sans réponse n'a rien délivré, donc la rejouer ne double
   * aucun effet serveur. `chat.sendMessage` NE l'active PAS — sa déduplication
   * vit dans lib/outbox, qui garde la ligne « en-attente » pour un rejeu propre.
   */
  networkReplay?: boolean;
  /**
   * Chemin servi HORS de `/api/v1/`. Un seul cas : `/api/info`, la seule
   * route Rocket.Chat utile qui vive à la racine. Sans cela, elle échappait à
   * toute la défense de ce module — délai maximal en tête — et pouvait
   * bloquer l'écran de connexion à vie (voir `lib/server.ts`).
   */
  outsideApiV1?: boolean;
};

/** Injectables pour les tests : aucun sommeil réel, aucune horloge réelle. */
export type Dependencies = {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Dispersion des rejeux. Injecté pour que les délais restent testables. */
  random: () => number;
};

const TIMEOUT_MS = 15_000;
const ATTEMPTS_429 = 3;
/** Un seul rejeu sur échec réseau : une connexion keep-alive morte repart neuve. */
const NETWORK_ATTEMPTS = 1;
const NETWORK_RETRY_DELAY_MS = 400;
/**
 * Dispersion ajoutée au rejeu d'un 429. Sans elle, deux appels concurrents
 * reçoivent le MÊME `x-ratelimit-reset` et se réveillent à la même
 * milliseconde : ils repartent en rafale sur une fenêtre qui vient tout juste
 * de rouvrir, et se reprennent un 429. Même raison que la gigue du pilote de
 * reconnexion (`lib/reconnect.ts`) — un troupeau tonnant, à deux têtes.
 */
const JITTER_429_MS = 500;

type RocketChatResponse = {
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

const METHODS: readonly TwoFactorMethod[] = ['totp', 'email', 'password'];

function isMethod(v: unknown): v is TwoFactorMethod {
  return typeof v === 'string' && (METHODS as readonly string[]).includes(v);
}

/** Même forme que l'`AbortError` de `fetch`, sans dépendre de `DOMException`. */
function cancelError(): Error {
  const e = new Error('Request canceled.');
  e.name = 'AbortError';
  return e;
}

export class ClientRest {
  readonly baseUrl: string;
  auth: RestAuth | null = null;

  /**
   * Appelé quand le serveur refuse le jeton (`estJetonRefuse`), avec le jeton
   * **réellement envoyé** — pas celui qui est courant à la réception.
   *
   * C'est la seule façon de couvrir toute la vie courante sans toucher un seul
   * site d'appel : `rattraperGlobal`, `chat.syncMessages`, `chat.sendMessage`,
   * `users.presence`… passent tous par ici. Sans ce crochet, un jeton révoqué
   * en cours de session (mot de passe changé ailleurs, `Accounts_LoginExpiration`,
   * `logoutOtherClients`) laissait l'app en état zombie : cache d'hier affiché,
   * barre de synchro qui bat, tout envoi en échec — l'aspect exact d'un
   * problème réseau, et aucun chemin de sortie avant un redémarrage.
   *
   * Le jeton est passé pour que l'abonné puisse ignorer un 401 **tardif**,
   * arrivé sur un jeton déjà remplacé (déconnexion puis reconnexion pendant que
   * la requête volait). `ClientRest` ne connaît pas la notion de session : il
   * rapporte, il ne décide pas.
   */
  onTokenRejected: ((token: string) => void) | null = null;

  private readonly dep: Dependencies;

  constructor(baseUrl: string, dep?: Partial<Dependencies>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dep = {
      fetch: dep?.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: dep?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: dep?.now ?? (() => Date.now()),
      random: dep?.random ?? Math.random,
    };
  }

  /**
   * Dort, mais en ÉCOUTANT l'annulation.
   *
   * `appeler()` retire son écouteur d'annulation dans son `finally`, donc
   * avant le sommeil de rejeu : un `abort()` pendant ces secondes-là n'était
   * constaté qu'au retour de récursion — jusqu'à 30 s plus tard, 90 s
   * cumulés sur trois tentatives. La promesse rendue à l'appelant restait
   * pendante d'autant, et son spinner avec elle.
   */
  private async cancelableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.dep.sleep(ms);
    if (signal.aborted) throw cancelError();
    let onAbort: () => void = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelError());
      signal.addEventListener('abort', onAbort);
    });
    try {
      await Promise.race([this.dep.sleep(ms), cancellation]);
    } finally {
      // Détaché dans tous les cas : sans quoi un `abort()` postérieur au
      // réveil rejetterait une promesse que plus personne n'observe.
      signal.removeEventListener('abort', onAbort);
    }
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('POST', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('DELETE', path, options);
  }

  private buildUrl(path: string, options: RequestOptions): string {
    const prefix = options.outsideApiV1 === true ? '' : 'api/v1/';
    const url = new URL(`${this.baseUrl}/${prefix}${path}`);
    const params = options.params;
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(options: RequestOptions): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!options.anonymous && this.auth) {
      h['X-Auth-Token'] = this.auth.authToken;
      h['X-User-Id'] = this.auth.userId;
    }
    if (options.twoFactor) {
      h['x-2fa-code'] = options.twoFactor.code;
      h['x-2fa-method'] = options.twoFactor.method;
    }
    return h;
  }

  /**
   * Délai avant nouvelle tentative sur 429. Le serveur donne la date de
   * réinitialisation en epoch ms dans `x-ratelimit-reset` ; à défaut, repli
   * exponentiel. On plafonne : un en-tête aberrant ne doit pas geler l'app.
   *
   * La dispersion s'ajoute AVANT le plafond, pour qu'un en-tête aberrant
   * reste borné à 30 s.
   */
  private delayAfter429(response: Response, attempt: number): number {
    const raw = Number(response.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(raw) ? raw - this.dep.now() : 0;
    const delay = wait > 0 ? wait + 250 : 1000 * 2 ** attempt;
    return Math.min(delay + this.dep.random() * JITTER_429_MS, 30_000);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: RequestOptions,
    attempt = 0,
    networkAttempt = 0,
  ): Promise<T> {
    // Un signal DÉJÀ avorté ne déclenchera jamais `addEventListener`, et la
    // requête partirait quand même : on le teste avant d'ouvrir la connexion.
    // Ni `AbortSignal.throwIfAborted` ni `DOMException` ne sont garantis sous
    // Hermes, d'où l'erreur construite à la main.
    if (options.signal?.aborted) throw cancelError();

    // Le jeton tel qu'il part sur le fil, capturé AVANT la requête. Le relire à
    // la réception rendrait le jeton COURANT : sur une session remplacée
    // pendant le vol, un 401 portant l'ancien jeton se présenterait alors sous
    // le nouveau, et effacerait une session toute neuve.
    const sentToken = options.anonymous === true ? null : (this.auth?.authToken ?? null);

    const controller = new AbortController();
    let expire = false;
    const timer = setTimeout(() => {
      expire = true;
      controller.abort();
    }, TIMEOUT_MS);
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay);

    let response: Response;
    try {
      response = await this.dep.fetch(this.buildUrl(path, options), {
        method,
        headers: this.headers(options),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (!expire) throw e; // Annulation demandée par l'appelant.
        throw new RestError(`${path}: no response within ${TIMEOUT_MS / 1000} s.`, 0);
      }
      // Échec réseau : le `fetch` a rejeté sans réponse HTTP. Sur Android/OkHttp,
      // la PREMIÈRE requête après un temps d'inactivité (ici : le temps de
      // remplir le formulaire) réutilise parfois une connexion keep-alive morte
      // et échoue, là où l'envoi immédiat suivant repart sur une connexion neuve
      // — le classique « ça passe à la 2e fois ». Rien n'ayant été reçu du
      // serveur, la requête n'a (quasi) jamais été délivrée : la rejouer ne
      // double aucun effet, mais on ne le fait que si l'appelant l'a demandé.
      if (options.networkReplay && networkAttempt < NETWORK_ATTEMPTS) {
        // Le `finally` ferme minuterie et listener à l'évaluation du `return` ;
        // la récursion en réarme de neufs. Les 400 ms d'attente restent bien en
        // deçà du timeout de 15 s, donc l'ancien timer ne fire pas entre-temps.
        await this.cancelableSleep(NETWORK_RETRY_DELAY_MS, options.signal);
        return this.call<T>(method, path, options, attempt, networkAttempt + 1);
      }
      throw new RestError(`${path}: server unreachable.`, 0);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
    }

    if (response.status === 429 && attempt < ATTEMPTS_429) {
      const delay = this.delayAfter429(response, attempt);
      await response.body?.cancel();
      await this.cancelableSleep(delay, options.signal);
      return this.call<T>(method, path, options, attempt + 1, networkAttempt);
    }

    // Lire le texte avant de parser : un reverse proxy peut renvoyer du HTML
    // avec un code 200, et « JSON invalide » n'est pas « serveur injoignable ».
    const text = await response.text();

    // `POST /api/v1/logout` répond 200 avec un corps VIDE — vérifié contre un
    // serveur 8.5. Un succès sans contenu n'est pas une erreur de format.
    if (text.trim() === '' && response.ok) return {} as T;

    let json: RocketChatResponse & Record<string, unknown>;
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new RestError(
        `${path}: non-JSON response (${response.status}, ${text.length} bytes).`,
        response.status,
      );
    }

    // Rocket.Chat 8.5 signale la 2FA sous DEUX formes selon l'endpoint :
    //   /api/v1/login      -> { error: 'totp-required' }      (sans errorType)
    //   /api/v1/settings/* -> { errorType: 'totp-required' }  (sans error)
    // Vérifié contre un serveur réel. Ne tester que `errorType` laissait la 2FA
    // du login remonter comme une ErreurRest ordinaire.
    if (json.errorType === 'totp-required' || json.error === 'totp-required') {
      const raw = json.details?.availableMethods ?? [];
      const requestedMethod = isMethod(json.details?.method) ? json.details.method : 'password';
      throw new TwoFactorError(
        requestedMethod,
        raw.filter(isMethod),
        json.details?.codeGenerated === true,
      );
    }

    // Rocket.Chat mélange deux conventions : `success: false` sur /api/v1/* et
    // `status: 'error'` sur /api/v1/login. Les deux valent échec.
    if (!response.ok || json.success === false || json.status === 'error') {
      const message = json.error ?? json.message ?? `${path} failed`;
      // « Du JSON » ne suffit pas à dire « du Rocket.Chat ». Une passerelle
      // d'API répond volontiers `{"message":"Unauthorized"}` en 401 : ça parse,
      // et ça ne dit RIEN de notre jeton. On exige donc une marque de
      // l'enveloppe maison — c'est elle que `reponseComprise` certifie.
      const rcEnvelope =
        typeof json.success === 'boolean' ||
        json.status === 'error' ||
        typeof json.errorType === 'string';
      const error = new RestError(
        message,
        response.status,
        json.error,
        json.errorType,
        rcEnvelope,
      );
      // Placé APRÈS la branche `totp-required` (jamais sur un défi 2FA) et
      // APRÈS le parse (jamais sur un 401 HTML de proxy). Un appel `anonyme`
      // n'a envoyé aucun jeton : son 401 ne dit rien de la session.
      if (sentToken !== null && isTokenRejected(error)) this.onTokenRejected?.(sentToken);
      throw error;
    }

    return json as T;
  }
}
