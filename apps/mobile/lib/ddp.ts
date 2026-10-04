/**
 * Mini-client DDP pour Rocket.Chat — **écoute seule**.
 *
 * Les appels de méthodes DDP sont dépréciés depuis Rocket.Chat 8.0, avec
 * retrait annoncé en 9.0 : on agit en REST, on écoute en DDP. La seule méthode
 * qu'on appelle est `login`, indispensable — le spike 1.7 l'a établi, une `sub`
 * sans session authentifiée reçoit `nosub: not-allowed`, **même sur un canal
 * public**.
 *
 * Écrit depuis la spécification DDP et l'observation du trafic. On ne recopie
 * pas `@rocket.chat/ddp-client`, dont la licence est ambiguë.
 *
 * Le `WebSocket` est injecté : celui de React Native et celui de Node exposent
 * la même API navigateur, donc ce module tourne sous Node et se teste pour de
 * vrai.
 */

/** Le sous-ensemble de `WebSocket` dont on dépend. */
export type WebSocketLike = {
  send(donnees: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type DdpEvent = {
  /** Nom du stream, p. ex. `stream-room-messages`. */
  collection: string;
  /** Clé de l'événement : un `rid`, ou `<uid>/subscriptions-changed`. */
  eventKey: string;
  /** Charge utile. Le premier élément porte l'essentiel. */
  args: unknown[];
};

export type DdpState = 'closed' | 'connecting' | 'connected' | 'authenticated';

export class DdpError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ErreurDdp';
    this.details = details;
  }
}

type Attente = {
  resolve: (valeur: unknown) => void;
  reject: (raison: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type OptionsDdp = {
  createWebSocket?: (url: string) => WebSocketLike;
  /** Délai au-delà duquel une `method` ou une `sub` est considérée perdue. */
  timeoutMs?: number;
  /**
   * Silence serveur au-delà duquel la socket est tenue pour suspecte. Voir
   * `SILENCE_MAX_MS`. Réglable pour les tests, pas pour la production.
   */
  silenceMaxMs?: number;
  /** Cadence du chien de garde. Voir `GARDE_MS`. */
  watchdogMs?: number;
};

/**
 * Le serveur DDP ping ses clients **toutes les 30 s** — mesuré contre
 * Rocket.Chat 8.5 (premier ping à +15 s de `connected`, puis 30 s pile). Le
 * protocole GARANTIT donc un trafic descendant régulier, même salon muet.
 *
 * Passé un ping entier manqué, la socket ne peut plus être saine : on tient le
 * silence pour une mort. Le seuil ne parie donc pas sur la latence du réseau —
 * il découle du rythme que le serveur s'impose.
 */
const SILENCE_MAX_MS = 45_000;
/** Cadence de vérification : assez fine pour ne pas ajouter au seuil. */
const GARDE_MS = 15_000;

type SouscriptionDesiree = {
  name: string;
  eventKey: string;
  /** Nombre d'appelants. La `sub` ne part qu'une fois, l'`unsub` qu'au dernier départ. */
  refs: number;
  /** Identifiant sur le fil, ou `null` si rien n'est établi (socket tombée, pas encore authentifié). */
  id: string | null;
  /** `sub` en cours de négociation sur le fil. */
  inFlight: boolean;
  /**
   * La négociation en cours, vue comme une promesse qui ne rejette JAMAIS :
   * elle retombe sur le `ready` du serveur, sur un `nosub`, ou sur la mort de
   * la socket. C'est ce que `souscriptionsArmees()` attend.
   */
  ready: Promise<void> | null;
};

type MessageDdp = {
  msg?: string;
  id?: string;
  session?: string;
  subs?: string[];
  collection?: string;
  error?: unknown;
  result?: unknown;
  fields?: { eventName?: string; args?: unknown[] };
  /** Sur `msg: 'error'` : la raison du refus, en clair. */
  reason?: string;
  /** Sur `msg: 'error'` : le message refusé, tel qu'on l'avait envoyé. */
  offendingMessage?: { id?: string };
};

export class ClientDdp {
  readonly url: string;
  state: DdpState = 'closed';
  session: string | null = null;

  private ws: WebSocketLike | null = null;
  private counter = 0;
  private closedOnPurpose = false;
  private readonly pending = new Map<string, Attente>();
  private readonly listeners = new Set<(e: DdpEvent) => void>();
  private readonly lossListeners = new Set<() => void>();
  /**
   * Souscriptions **désirées**, indexées par `nom|clé`. Survivent à une
   * fermeture de socket, pour que l'étape 5.1 puisse les rejouer : c'est le
   * seul état qui doit traverser une reconnexion.
   *
   * `refs` compte les appelants. Deux écrans qui observent le même salon ne
   * doivent produire qu'une seule `sub` sur le fil — sinon le serveur envoie
   * chaque message en double, ce que `ROADMAP.md` reproche à l'app officielle.
   */
  private readonly wanted = new Map<string, SouscriptionDesiree>();
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  /**
   * Rejette la négociation en cours. Elle vit hors de `attentes` (elle n'a pas
   * d'`id` DDP) : sans ce crochet, un `fermer()` pendant `connecter()`
   * laisserait la promesse pendre jusqu'à son délai — dix secondes de zombie
   * à chaque démontage un peu rapide.
   */
  private cancelHandshake: ((raison: unknown) => void) | null = null;
  private readonly silenceMaxMs: number;
  private readonly watchdogMs: number;
  /** Date du dernier octet reçu du serveur, tous messages confondus. */
  private lastTraffic = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Une seule sonde à la fois : le chien de garde tique plus vite qu'elle. */
  private probeInFlight = false;
  /**
   * `nettoyer()` a déjà couru sur cette socket. Vrai au départ : un client
   * neuf n'a rien à nettoyer. Remis à faux par `connecter()`.
   */
  private cleanedUp = true;

  constructor(url: string, options: OptionsDdp = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.silenceMaxMs = options.silenceMaxMs ?? SILENCE_MAX_MS;
    this.watchdogMs = options.watchdogMs ?? GARDE_MS;
    this.createWebSocket =
      options.createWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  /** Souscriptions réellement établies sur le fil — l'écran debug de 3.6 s'en sert. */
  get subscriptionCount(): number {
    let n = 0;
    for (const s of this.wanted.values()) if (s.id !== null) n++;
    return n;
  }

  /** Souscriptions demandées, établies ou non. Diffère de la précédente si la socket est tombée. */
  get wantedSubscriptionCount(): number {
    return this.wanted.size;
  }

  onEvent(ecouteur: (e: DdpEvent) => void): () => void {
    this.listeners.add(ecouteur);
    return () => this.listeners.delete(ecouteur);
  }

  /**
   * Prévenu quand la connexion se perd SANS qu'on l'ait demandé — jamais sur
   * `fermer()`. C'est le signal du pilote de reconnexion (5.1) : notifier une
   * fermeture volontaire déclencherait une reconnexion après la déconnexion.
   */
  onLoss(ecouteur: () => void): () => void {
    this.lossListeners.add(ecouteur);
    return () => this.lossListeners.delete(ecouteur);
  }

  /**
   * Ouvre la socket, négocie DDP, puis s'authentifie avec le jeton REST.
   * `authToken` est celui de `POST /api/v1/login` : un seul secret pour les
   * deux transports.
   */
  async connect(authToken: string): Promise<void> {
    if (this.state !== 'closed') throw new DdpError('Client déjà connecté.');
    this.state = 'connecting';
    this.closedOnPurpose = false;
    this.cleanedUp = false;

    await new Promise<void>((resoudre, rejeter) => {
      // Le timeout NETTOIE, il ne fait pas que rejeter : sinon l'état reste
      // « connexion » avec une socket ouverte, et toute retentative du pilote
      // de reconnexion échouerait à jamais sur « déjà connecté ».
      const minuterie = setTimeout(() => {
        const erreur = new DdpError(`Pas de « connected » en ${this.timeoutMs} ms.`);
        this.ws?.close();
        this.cleanUp(erreur);
        rejeter(erreur);
      }, this.timeoutMs);
      this.cancelHandshake = (raison) => {
        clearTimeout(minuterie);
        rejeter(raison instanceof Error ? raison : new DdpError('Connexion interrompue.'));
      };
      const ws = this.createWebSocket(this.url);
      this.ws = ws;

      // Le `close` d'une socket abandonnée arrive de façon asynchrone, souvent
      // APRÈS qu'une nouvelle a été ouverte. Sans cette garde d'identité, son
      // `onclose` remettrait `this.ws` à null et l'état à « fermé » sous les
      // pieds de la connexion en cours : le `connect` ne partirait jamais.
      const estCourante = () => this.ws === ws;

      ws.onerror = () => {
        if (!estCourante()) return;
        clearTimeout(minuterie);
        this.cleanUp(new DdpError('Erreur WebSocket.'));
        rejeter(new DdpError('Erreur WebSocket.'));
      };
      ws.onclose = () => {
        if (!estCourante()) return;
        clearTimeout(minuterie);
        this.cleanUp(new DdpError('Socket fermée.'));
      };
      ws.onmessage = (e) => {
        if (!estCourante()) return;
        // AVANT tout traitement : ce qui compte pour le chien de garde est
        // qu'un octet soit arrivé, pas qu'il ait été compris.
        this.lastTraffic = Date.now();
        let m: MessageDdp;
        try {
          m = JSON.parse(String(e.data)) as MessageDdp;
        } catch {
          return; // Le serveur ne devrait pas, mais on ne meurt pas pour autant.
        }
        if (m.msg === 'connected') {
          clearTimeout(minuterie);
          this.cancelHandshake = null;
          this.session = m.session ?? null;
          this.state = 'connected';
          resoudre();
          return;
        }
        if (m.msg === 'failed') {
          clearTimeout(minuterie);
          this.cancelHandshake = null;
          // Même exigence que le timeout : laisser le client réutilisable.
          const erreur = new DdpError('Version DDP refusée par le serveur.');
          ws.close();
          this.cleanUp(erreur);
          rejeter(erreur);
          return;
        }
        this.receive(m);
      };
      ws.onopen = () => {
        if (estCourante()) this.send({ msg: 'connect', version: '1', support: ['1'] });
      };
    });

    try {
      await this.call('login', { resume: authToken });
    } catch (e) {
      // Sans cela, la socket reste ouverte et l'état bloqué sur « connecte » :
      // tout `connecter()` ultérieur lèverait « déjà connecté ».
      this.ws?.close();
      this.cleanUp(e);
      throw e;
    }
    this.state = 'authenticated';
    this.startWatchdog();

    // Rejouer les souscriptions désirées : celles demandées avant
    // l'authentification, et celles d'une socket précédente. C'est ce qui
    // permet à un écran de souscrire sans se soucier de l'état du transport —
    // et c'est le mécanisme que la reconnexion (5.1) réutilisera tel quel.
    for (const entree of this.wanted.values()) this.establish(entree);
  }

  /**
   * Déclare l'intérêt pour un stream et rend la fonction qui le relâche.
   *
   * **Synchrone et indépendant de l'état du transport** : appelée avant
   * l'authentification ou après une coupure, la souscription est simplement
   * mémorisée et établie dès que possible — `connecter()` rejoue toutes les
   * désirées à l'authentification. L'ancienne API rendait l'identifiant du
   * fil : il meurt avec la socket, et un écran qui s'en servait pour se
   * désabonner après une coupure laissait fuir sa référence pour toujours.
   */
  subscribe(nom: string, cleEvenement: string): () => void {
    const cle = `${nom}|${cleEvenement}`;
    const entree: SouscriptionDesiree = this.wanted.get(cle) ?? {
      name: nom,
      eventKey: cleEvenement,
      refs: 0,
      id: null,
      inFlight: false,
      ready: null,
    };
    entree.refs++;
    this.wanted.set(cle, entree);
    this.establish(entree);

    // Idempotente par appelant : un double appel ne doit pas voler la
    // référence d'un autre écran.
    let rendue = false;
    return () => {
      if (rendue) return;
      rendue = true;
      this.release(cle);
    };
  }

  /**
   * Envoie la `sub` sur le fil si l'état le permet. Une seule par entrée :
   * deux appelants du même tick partagent la négociation (`enVol`), sinon le
   * serveur reçoit deux `sub` et duplique chaque événement.
   *
   * `params` reçoit toujours l'objet `{ useCollection: false, args: [] }` en
   * dernier argument : c'est la convention des « streamers » de Rocket.Chat.
   */
  private establish(entree: SouscriptionDesiree): void {
    if (this.state !== 'authenticated' || entree.id !== null || entree.inFlight) return;
    const cle = `${entree.name}|${entree.eventKey}`;
    const id = `s${++this.counter}`;
    entree.inFlight = true;

    entree.ready = this.waitFor(id, `sub ${entree.name}`)
      .then(() => {
        entree.inFlight = false;
        if (this.wanted.get(cle) !== entree) {
          // Relâchée pendant la négociation : le serveur vient de l'établir,
          // on la coupe aussitôt plutôt que de la laisser fuir.
          this.send({ msg: 'unsub', id });
          return;
        }
        entree.id = id;
      })
      .catch(() => {
        // `nosub` ou socket morte : `id` reste null. L'entrée reste désirée
        // et sera retentée à la prochaine authentification.
        entree.inFlight = false;
      });

    this.send({
      msg: 'sub',
      id,
      name: entree.name,
      params: [entree.eventKey, { useCollection: false, args: [] }],
    });
  }

  /** Ne coupe la souscription sur le fil que lorsque le dernier appelant s'en va. */
  private release(cle: string): void {
    const entree = this.wanted.get(cle);
    if (entree === undefined) return;
    if (--entree.refs > 0) return;
    this.wanted.delete(cle);
    // Si une négociation est en vol, son `.then` verra l'entrée disparue et
    // enverra l'`unsub` lui-même.
    if (entree.id !== null) this.send({ msg: 'unsub', id: entree.id });
  }

  close(): void {
    this.closedOnPurpose = true;
    this.ws?.close();
    this.cleanUp(new DdpError('Client fermé.'));
  }

  /**
   * Résolue quand le serveur a ARMÉ les souscriptions désirées à l'instant de
   * l'appel : leur `ready` reçu, leur `nosub` constaté, ou la socket morte.
   *
   * C'est le seul signal EXACT du moment où le stream commence à couvrir. Une
   * lecture REST démarrée après lui ne peut plus laisser de trou : tout ce que
   * le serveur publie ensuite arrive par le fil. Le raccordement s'en sert au
   * lieu d'un délai — la justesse ne doit dépendre ni de la latence ni de la
   * qualité du réseau (voir `lib/connectionSetup.ts`).
   *
   * Ne rejette jamais : une souscription qui échoue reste désirée et sera
   * rejouée à la prochaine authentification.
   */
  async armedSubscriptions(): Promise<void> {
    const negociations: Promise<void>[] = [];
    for (const entree of this.wanted.values()) {
      if (entree.ready !== null) negociations.push(entree.ready);
    }
    await Promise.all(negociations);
  }

  /**
   * Chien de garde du silence. Une socket peut mourir SANS que le WebSocket
   * n'appelle jamais `onclose` : le serveur envoie son FIN, la socket part en
   * CLOSE-WAIT côté OS, et rien ne remonte au JS. Le client se croit alors
   * `authentifie` pour toujours — `surPerte` ne part pas, le pilote de
   * reconnexion n'est jamais réveillé, et plus aucun message n'arrive.
   *
   * Constaté en vrai, reproduit sur l'AVD : après un téléversement de pièce
   * jointe, quatre sockets vers le serveur en CLOSE-WAIT, aucun événement DDP,
   * et les messages suivants jamais reçus — jusqu'à un passage en arrière-plan
   * (qui sondait, lui) ou un redémarrage de l'app.
   *
   * Le seuil n'est pas un pari sur le réseau mais une lecture du protocole :
   * le serveur ping toutes les 30 s (mesuré), donc un silence de 45 s prouve
   * qu'un ping s'est perdu. On ne coupe pas pour autant — on SONDE, et c'est
   * l'absence de pong qui tranche.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastTraffic = Date.now();
    this.watchdog = setInterval(() => {
      if (this.state === 'closed' || this.probeInFlight) return;
      if (Date.now() - this.lastTraffic < this.silenceMaxMs) return;
      this.probeInFlight = true;
      void this.checkAlive().finally(() => {
        this.probeInFlight = false;
      });
    }, this.watchdogMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Sonde de vie : un ping DDP dont on attend le pong. Une socket à moitié
   * morte (NAT tombé pendant la veille, sans FIN ni RST) ne répondra jamais
   * ET ne fermera jamais — on la nettoie nous-mêmes, ce qui notifie
   * `surPerte` et laisse le pilote de reconnexion reprendre la main.
   */
  async checkAlive(): Promise<boolean> {
    // Une NÉGOCIATION en cours ne se sonde pas. Sondé sur le banc 8.5.1 : un
    // `ping` envoyé avant le `connect` reçoit `{msg:'error', reason:'Must
    // connect first', offendingMessage:{id}}`, jamais de `pong`. Le `catch`
    // ci-dessous fermerait alors une socket qui, dix secondes plus tard, a
    // terminé son login et rejoué ses souscriptions. La négociation a déjà
    // son propre délai (`delaiMs`) : elle n'a pas besoin qu'on la surveille.
    //
    // L'état `connecte` (handshake fait, login pas encore répondu) est en
    // revanche bien sondable — même sonde, `pong` reçu.
    if (this.state !== 'connected' && this.state !== 'authenticated') return false;
    const id = `v${++this.counter}`;
    try {
      const promesse = this.waitFor(id, 'sonde de vie');
      this.send({ msg: 'ping', id });
      await promesse;
      return true;
    } catch {
      // Le cast : TypeScript ne voit pas que `etat` a pu changer pendant
      // l'await (une coupure concurrente a pu déjà nettoyer).
      if ((this.state as DdpState) !== 'closed') {
        this.ws?.close();
        this.cleanUp(new DdpError('Sonde de vie sans réponse : socket morte.'));
      }
      return false;
    }
  }

  /** Seule méthode DDP encore appelée : `login`. Voir l'en-tête du fichier. */
  private call(methode: string, ...params: unknown[]): Promise<unknown> {
    const id = `m${++this.counter}`;
    const promesse = this.waitFor(id, `method ${methode}`);
    this.send({ msg: 'method', id, method: methode, params });
    return promesse;
  }

  private waitFor(id: string, quoi: string): Promise<unknown> {
    return new Promise((resoudre, rejeter) => {
      const minuterie = setTimeout(() => {
        this.pending.delete(id);
        rejeter(new DdpError(`${quoi} : ni réponse ni erreur en ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resoudre, reject: rejeter, timer: minuterie });
    });
  }

  private finish(id: string, valeur: unknown, erreur?: unknown): void {
    const attente = this.pending.get(id);
    if (!attente) return;
    this.pending.delete(id);
    clearTimeout(attente.timer);
    erreur === undefined ? attente.resolve(valeur) : attente.reject(erreur);
  }

  private receive(m: MessageDdp): void {
    switch (m.msg) {
      case 'ping':
        // Le serveur coupe la socket sans pong. L'`id` n'est présent que si le
        // ping en portait un.
        this.send(m.id === undefined ? { msg: 'pong' } : { msg: 'pong', id: m.id });
        break;

      case 'pong':
        // Réponse à NOTRE ping (sonde de vie).
        if (m.id !== undefined) this.finish(m.id, 'pong');
        break;

      case 'result':
        if (m.id !== undefined) {
          this.finish(
            m.id,
            m.result,
            m.error === undefined ? undefined : new DdpError('Méthode refusée.', m.error),
          );
        }
        break;

      case 'ready':
        for (const id of m.subs ?? []) this.finish(id, 'ready');
        break;

      case 'nosub':
        if (m.id !== undefined) {
          this.finish(m.id, undefined, new DdpError('Souscription refusée.', m.error));
        }
        break;

      case 'error': {
        // Refus d'un message mal formé ou hors séquence. Le serveur ne
        // répondra JAMAIS à l'id fautif : sans ce cas, l'attente pend
        // jusqu'à `delaiMs` et son échec est mis sur le compte de la socket.
        // Relevé sur le banc 8.5.1 — l'erreur porte bien le message refusé,
        // donc son `id` : on peut rejeter la bonne attente, pas toutes.
        const id = m.offendingMessage?.id;
        if (typeof id === 'string') {
          this.finish(id, undefined, new DdpError(`Message refusé : ${m.reason ?? 'sans raison'}`));
        }
        break;
      }

      case 'changed': {
        // Format des streamers : `collection` = nom du stream, la clé est dans
        // `fields.eventName`, la charge utile dans `fields.args`.
        const cleEvenement = m.fields?.eventName;
        if (m.collection === undefined || cleEvenement === undefined) break;
        const evenement: DdpEvent = {
          collection: m.collection,
          eventKey: cleEvenement,
          args: m.fields?.args ?? [],
        };
        // Un écouteur qui lève ne doit pas empêcher les autres de recevoir.
        for (const ecouteur of [...this.listeners]) {
          try {
            ecouteur(evenement);
          } catch {
            /* ignoré volontairement */
          }
        }
        break;
      }

      default:
        // `added`, `removed`, `updated` : sans objet quand useCollection=false.
        break;
    }
  }

  private send(objet: unknown): void {
    this.ws?.send(JSON.stringify(objet));
  }

  /**
   * Rejette tout ce qui est en vol : sans cela, les promesses pendraient.
   *
   * Les souscriptions **désirées** survivent : ce sont elles que l'étape 5.1
   * rejouera à la reconnexion. Seuls leurs identifiants de fil sont oubliés,
   * puisqu'ils appartenaient à la socket morte.
   *
   * **Idempotent.** Une socket qui meurt pendant le login passe ici deux fois :
   * une par `onclose`, une par le `catch` de `connecter()` — l'attente du login
   * ayant été rejetée par le premier passage. Sans sortie anticipée, `surPerte`
   * partirait deux fois, et le second passage réémettrait l'événement sur un
   * objet déjà entièrement vidé.
   */
  private cleanUp(raison: unknown): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.stopWatchdog();
    // Détacher les gestionnaires : une socket abandonnée ne doit plus rien dire.
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    // Une négociation en vol est rejetée tout de suite — pas au bout du délai.
    this.cancelHandshake?.(raison);
    this.cancelHandshake = null;
    for (const [id] of this.pending) this.finish(id, undefined, raison);
    this.pending.clear();
    for (const s of this.wanted.values()) {
      s.id = null;
      s.inFlight = false;
    }
    this.state = 'closed';
    this.session = null;
    this.ws = null;

    if (!this.closedOnPurpose) {
      for (const ecouteur of [...this.lossListeners]) {
        try {
          ecouteur();
        } catch {
          /* un écouteur qui lève ne bloque pas les autres */
        }
      }
    }
  }

  /** Oublie tout, y compris les souscriptions désirées. À la déconnexion. */
  reset(): void {
    this.wanted.clear();
  }
}
