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
  readonly reponseComprise: boolean;

  constructor(
    message: string,
    statut: number,
    erreur?: string,
    errorType?: string,
    reponseComprise = false,
  ) {
    super(message);
    this.name = 'ErreurRest';
    this.statut = statut;
    this.erreur = erreur;
    this.errorType = errorType;
    this.reponseComprise = reponseComprise;
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
    // `reponseComprise` vaut bien TRUE : un défi 2FA est une réponse
    // Rocket.Chat en bonne et due forme, lue comme telle. Ce qui l'écarte
    // d'une révocation est son TYPE, pas un défaut de lecture — et c'est ce
    // qui rend la garde `instanceof` du prédicat portante plutôt que
    // décorative. Le 401 déclaré ici, lui, ne reflète pas le statut HTTP :
    // hors login, 8.5 répond 400.
    super(`Double authentification requise (${methode})`, 401, undefined, 'totp-required', true);
    this.name = 'ErreurDeuxFacteurs';
    this.methode = methode;
    this.methodesDisponibles = methodesDisponibles;
    this.codeGenere = codeGenere;
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
export function estJetonRefuse(e: unknown): boolean {
  if (e instanceof ErreurDeuxFacteurs) return false;
  if (!(e instanceof ErreurRest)) return false;
  return e.statut === 401 && e.reponseComprise;
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
  /**
   * Chemin servi HORS de `/api/v1/`. Un seul cas : `/api/info`, la seule
   * route Rocket.Chat utile qui vive à la racine. Sans cela, elle échappait à
   * toute la défense de ce module — délai maximal en tête — et pouvait
   * bloquer l'écran de connexion à vie (voir `lib/server.ts`).
   */
  horsApiV1?: boolean;
};

/** Injectables pour les tests : aucun sommeil réel, aucune horloge réelle. */
export type Dependances = {
  fetch: typeof globalThis.fetch;
  dormir: (ms: number) => Promise<void>;
  maintenant: () => number;
  /** Dispersion des rejeux. Injecté pour que les délais restent testables. */
  alea: () => number;
};

const DELAI_MS = 15_000;
const TENTATIVES_429 = 3;
/** Un seul rejeu sur échec réseau : une connexion keep-alive morte repart neuve. */
const TENTATIVES_RESEAU = 1;
const DELAI_REJEU_RESEAU_MS = 400;
/**
 * Dispersion ajoutée au rejeu d'un 429. Sans elle, deux appels concurrents
 * reçoivent le MÊME `x-ratelimit-reset` et se réveillent à la même
 * milliseconde : ils repartent en rafale sur une fenêtre qui vient tout juste
 * de rouvrir, et se reprennent un 429. Même raison que la gigue du pilote de
 * reconnexion (`lib/reconnexion.ts`) — un troupeau tonnant, à deux têtes.
 */
const DISPERSION_429_MS = 500;

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
  surJetonRefuse: ((jeton: string) => void) | null = null;

  private readonly dep: Dependances;

  constructor(baseUrl: string, dep?: Partial<Dependances>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dep = {
      fetch: dep?.fetch ?? globalThis.fetch.bind(globalThis),
      dormir: dep?.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maintenant: dep?.maintenant ?? (() => Date.now()),
      alea: dep?.alea ?? Math.random,
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
  private async dormirAnnulable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.dep.dormir(ms);
    if (signal.aborted) throw erreurAnnulation();
    let surAbandon: () => void = () => {};
    const annulation = new Promise<never>((_, rejeter) => {
      surAbandon = () => rejeter(erreurAnnulation());
      signal.addEventListener('abort', surAbandon);
    });
    try {
      await Promise.race([this.dep.dormir(ms), annulation]);
    } finally {
      // Détaché dans tous les cas : sans quoi un `abort()` postérieur au
      // réveil rejetterait une promesse que plus personne n'observe.
      signal.removeEventListener('abort', surAbandon);
    }
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

  private construireUrl(chemin: string, options: OptionsAppel): string {
    const prefixe = options.horsApiV1 === true ? '' : 'api/v1/';
    const url = new URL(`${this.baseUrl}/${prefixe}${chemin}`);
    const params = options.params;
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
   *
   * La dispersion s'ajoute AVANT le plafond, pour qu'un en-tête aberrant
   * reste borné à 30 s.
   */
  private delaiApres429(reponse: Response, tentative: number): number {
    const brut = Number(reponse.headers.get('x-ratelimit-reset'));
    const attente = Number.isFinite(brut) ? brut - this.dep.maintenant() : 0;
    const delai = attente > 0 ? attente + 250 : 1000 * 2 ** tentative;
    return Math.min(delai + this.dep.alea() * DISPERSION_429_MS, 30_000);
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

    // Le jeton tel qu'il part sur le fil, capturé AVANT la requête. Le relire à
    // la réception rendrait le jeton COURANT : sur une session remplacée
    // pendant le vol, un 401 portant l'ancien jeton se présenterait alors sous
    // le nouveau, et effacerait une session toute neuve.
    const jetonEnvoye = options.anonyme === true ? null : (this.identifiants?.authToken ?? null);

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
      reponse = await this.dep.fetch(this.construireUrl(chemin, options), {
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
        await this.dormirAnnulable(DELAI_REJEU_RESEAU_MS, options.signal);
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
      await this.dormirAnnulable(delai, options.signal);
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
      // « Du JSON » ne suffit pas à dire « du Rocket.Chat ». Une passerelle
      // d'API répond volontiers `{"message":"Unauthorized"}` en 401 : ça parse,
      // et ça ne dit RIEN de notre jeton. On exige donc une marque de
      // l'enveloppe maison — c'est elle que `reponseComprise` certifie.
      const enveloppeRC =
        typeof json.success === 'boolean' ||
        json.status === 'error' ||
        typeof json.errorType === 'string';
      const erreur = new ErreurRest(
        message,
        reponse.status,
        json.error,
        json.errorType,
        enveloppeRC,
      );
      // Placé APRÈS la branche `totp-required` (jamais sur un défi 2FA) et
      // APRÈS le parse (jamais sur un 401 HTML de proxy). Un appel `anonyme`
      // n'a envoyé aucun jeton : son 401 ne dit rien de la session.
      if (jetonEnvoye !== null && estJetonRefuse(erreur)) this.surJetonRefuse?.(jetonEnvoye);
      throw erreur;
    }

    return json as T;
  }
}
