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

export type Evenement = {
  /** Nom du stream, p. ex. `stream-room-messages`. */
  collection: string;
  /** Clé de l'événement : un `rid`, ou `<uid>/subscriptions-changed`. */
  cleEvenement: string;
  /** Charge utile. Le premier élément porte l'essentiel. */
  args: unknown[];
};

export type EtatDdp = 'ferme' | 'connexion' | 'connecte' | 'authentifie';

export class ErreurDdp extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ErreurDdp';
    this.details = details;
  }
}

type Attente = {
  resoudre: (valeur: unknown) => void;
  rejeter: (raison: unknown) => void;
  minuterie: ReturnType<typeof setTimeout>;
};

export type OptionsDdp = {
  creerWebSocket?: (url: string) => WebSocketLike;
  /** Délai au-delà duquel une `method` ou une `sub` est considérée perdue. */
  delaiMs?: number;
};

type SouscriptionDesiree = {
  nom: string;
  cleEvenement: string;
  /** Nombre d'appelants. La `sub` ne part qu'une fois, l'`unsub` qu'au dernier départ. */
  refs: number;
  /** Identifiant sur le fil, ou `null` si la socket est tombée. */
  id: string | null;
  /** `sub` en cours de négociation : deux appelants du même tick l'attendent. */
  enVol: Promise<string> | null;
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
};

export class ClientDdp {
  readonly url: string;
  etat: EtatDdp = 'ferme';
  session: string | null = null;

  private ws: WebSocketLike | null = null;
  private compteur = 0;
  private readonly attentes = new Map<string, Attente>();
  private readonly ecouteurs = new Set<(e: Evenement) => void>();
  /**
   * Souscriptions **désirées**, indexées par `nom|clé`. Survivent à une
   * fermeture de socket, pour que l'étape 5.1 puisse les rejouer : c'est le
   * seul état qui doit traverser une reconnexion.
   *
   * `refs` compte les appelants. Deux écrans qui observent le même salon ne
   * doivent produire qu'une seule `sub` sur le fil — sinon le serveur envoie
   * chaque message en double, ce que `ROADMAP.md` reproche à l'app officielle.
   */
  private readonly desirees = new Map<string, SouscriptionDesiree>();
  private readonly creerWebSocket: (url: string) => WebSocketLike;
  private readonly delaiMs: number;

  constructor(url: string, options: OptionsDdp = {}) {
    this.url = url;
    this.delaiMs = options.delaiMs ?? 10_000;
    this.creerWebSocket =
      options.creerWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  /** Souscriptions réellement établies sur le fil — l'écran debug de 3.6 s'en sert. */
  get nombreSouscriptions(): number {
    let n = 0;
    for (const s of this.desirees.values()) if (s.id !== null) n++;
    return n;
  }

  /** Souscriptions demandées, établies ou non. Diffère de la précédente si la socket est tombée. */
  get nombreSouscriptionsDesirees(): number {
    return this.desirees.size;
  }

  surEvenement(ecouteur: (e: Evenement) => void): () => void {
    this.ecouteurs.add(ecouteur);
    return () => this.ecouteurs.delete(ecouteur);
  }

  /**
   * Ouvre la socket, négocie DDP, puis s'authentifie avec le jeton REST.
   * `authToken` est celui de `POST /api/v1/login` : un seul secret pour les
   * deux transports.
   */
  async connecter(authToken: string): Promise<void> {
    if (this.etat !== 'ferme') throw new ErreurDdp('Client déjà connecté.');
    this.etat = 'connexion';

    await new Promise<void>((resoudre, rejeter) => {
      const minuterie = setTimeout(
        () => rejeter(new ErreurDdp(`Pas de « connected » en ${this.delaiMs} ms.`)),
        this.delaiMs,
      );
      const ws = this.creerWebSocket(this.url);
      this.ws = ws;

      // Le `close` d'une socket abandonnée arrive de façon asynchrone, souvent
      // APRÈS qu'une nouvelle a été ouverte. Sans cette garde d'identité, son
      // `onclose` remettrait `this.ws` à null et l'état à « fermé » sous les
      // pieds de la connexion en cours : le `connect` ne partirait jamais.
      const estCourante = () => this.ws === ws;

      ws.onerror = () => {
        if (!estCourante()) return;
        clearTimeout(minuterie);
        this.nettoyer(new ErreurDdp('Erreur WebSocket.'));
        rejeter(new ErreurDdp('Erreur WebSocket.'));
      };
      ws.onclose = () => {
        if (!estCourante()) return;
        clearTimeout(minuterie);
        this.nettoyer(new ErreurDdp('Socket fermée.'));
      };
      ws.onmessage = (e) => {
        if (!estCourante()) return;
        let m: MessageDdp;
        try {
          m = JSON.parse(String(e.data)) as MessageDdp;
        } catch {
          return; // Le serveur ne devrait pas, mais on ne meurt pas pour autant.
        }
        if (m.msg === 'connected') {
          clearTimeout(minuterie);
          this.session = m.session ?? null;
          this.etat = 'connecte';
          resoudre();
          return;
        }
        if (m.msg === 'failed') {
          clearTimeout(minuterie);
          rejeter(new ErreurDdp('Version DDP refusée par le serveur.'));
          return;
        }
        this.recevoir(m);
      };
      ws.onopen = () => {
        if (estCourante()) this.envoyer({ msg: 'connect', version: '1', support: ['1'] });
      };
    });

    try {
      await this.appeler('login', { resume: authToken });
    } catch (e) {
      // Sans cela, la socket reste ouverte et l'état bloqué sur « connecte » :
      // tout `connecter()` ultérieur lèverait « déjà connecté ».
      this.ws?.close();
      this.nettoyer(e);
      throw e;
    }
    this.etat = 'authentifie';
  }

  /**
   * `params` reçoit toujours l'objet `{ useCollection: false, args: [] }` en
   * dernier argument : c'est la convention des « streamers » de Rocket.Chat.
   */
  async souscrire(nom: string, cleEvenement: string): Promise<string> {
    if (this.etat !== 'authentifie') {
      throw new ErreurDdp('Souscription avant authentification : le serveur répondrait not-allowed.');
    }
    const cle = `${nom}|${cleEvenement}`;
    const existante = this.desirees.get(cle);

    if (existante) {
      existante.refs++;
      // Déjà établie sur le fil.
      if (existante.id !== null) return existante.id;
      // `sub` déjà en vol : deux appelants du même tick doivent la partager,
      // sinon le serveur en reçoit deux et duplique chaque événement.
      if (existante.enVol !== null) {
        try {
          return await existante.enVol;
        } catch (e) {
          existante.refs--;
          throw e;
        }
      }
    }

    const id = `s${++this.compteur}`;
    // Une souscription redemandée après une coupure conserve ses références.
    const entree: SouscriptionDesiree = existante ?? {
      nom,
      cleEvenement,
      refs: 1,
      id: null,
      enVol: null,
    };
    entree.enVol = this.attendre(id, `sub ${nom}`).then(() => {
      entree.id = id;
      entree.enVol = null;
      return id;
    });
    this.desirees.set(cle, entree);

    this.envoyer({
      msg: 'sub',
      id,
      name: nom,
      params: [cleEvenement, { useCollection: false, args: [] }],
    });

    try {
      return await entree.enVol;
    } catch (e) {
      this.desirees.delete(cle);
      throw e;
    }
  }

  /** Ne coupe la souscription que lorsque le dernier appelant s'en va. */
  async desouscrire(id: string): Promise<void> {
    for (const [cle, s] of this.desirees) {
      if (s.id !== id) continue;
      if (--s.refs > 0) return;
      this.desirees.delete(cle);
      this.envoyer({ msg: 'unsub', id });
      return;
    }
  }

  fermer(): void {
    this.ws?.close();
    this.nettoyer(new ErreurDdp('Client fermé.'));
  }

  /** Seule méthode DDP encore appelée : `login`. Voir l'en-tête du fichier. */
  private appeler(methode: string, ...params: unknown[]): Promise<unknown> {
    const id = `m${++this.compteur}`;
    const promesse = this.attendre(id, `method ${methode}`);
    this.envoyer({ msg: 'method', id, method: methode, params });
    return promesse;
  }

  private attendre(id: string, quoi: string): Promise<unknown> {
    return new Promise((resoudre, rejeter) => {
      const minuterie = setTimeout(() => {
        this.attentes.delete(id);
        rejeter(new ErreurDdp(`${quoi} : ni réponse ni erreur en ${this.delaiMs} ms.`));
      }, this.delaiMs);
      this.attentes.set(id, { resoudre, rejeter, minuterie });
    });
  }

  private terminer(id: string, valeur: unknown, erreur?: unknown): void {
    const attente = this.attentes.get(id);
    if (!attente) return;
    this.attentes.delete(id);
    clearTimeout(attente.minuterie);
    erreur === undefined ? attente.resoudre(valeur) : attente.rejeter(erreur);
  }

  private recevoir(m: MessageDdp): void {
    switch (m.msg) {
      case 'ping':
        // Le serveur coupe la socket sans pong. L'`id` n'est présent que si le
        // ping en portait un.
        this.envoyer(m.id === undefined ? { msg: 'pong' } : { msg: 'pong', id: m.id });
        break;

      case 'result':
        if (m.id !== undefined) {
          this.terminer(
            m.id,
            m.result,
            m.error === undefined ? undefined : new ErreurDdp('Méthode refusée.', m.error),
          );
        }
        break;

      case 'ready':
        for (const id of m.subs ?? []) this.terminer(id, 'ready');
        break;

      case 'nosub':
        if (m.id !== undefined) {
          this.terminer(m.id, undefined, new ErreurDdp('Souscription refusée.', m.error));
        }
        break;

      case 'changed': {
        // Format des streamers : `collection` = nom du stream, la clé est dans
        // `fields.eventName`, la charge utile dans `fields.args`.
        const cleEvenement = m.fields?.eventName;
        if (m.collection === undefined || cleEvenement === undefined) break;
        const evenement: Evenement = {
          collection: m.collection,
          cleEvenement,
          args: m.fields?.args ?? [],
        };
        // Un écouteur qui lève ne doit pas empêcher les autres de recevoir.
        for (const ecouteur of [...this.ecouteurs]) {
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

  private envoyer(objet: unknown): void {
    this.ws?.send(JSON.stringify(objet));
  }

  /**
   * Rejette tout ce qui est en vol : sans cela, les promesses pendraient.
   *
   * Les souscriptions **désirées** survivent : ce sont elles que l'étape 5.1
   * rejouera à la reconnexion. Seuls leurs identifiants de fil sont oubliés,
   * puisqu'ils appartenaient à la socket morte.
   */
  private nettoyer(raison: unknown): void {
    // Détacher les gestionnaires : une socket abandonnée ne doit plus rien dire.
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    for (const [id] of this.attentes) this.terminer(id, undefined, raison);
    this.attentes.clear();
    for (const s of this.desirees.values()) {
      s.id = null;
      s.enVol = null;
    }
    this.etat = 'ferme';
    this.session = null;
    this.ws = null;
  }

  /** Oublie tout, y compris les souscriptions désirées. À la déconnexion. */
  reinitialiser(): void {
    this.desirees.clear();
  }
}
