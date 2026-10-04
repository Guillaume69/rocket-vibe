import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientDdp, DdpError, type DdpEvent, type WebSocketLike } from './ddp.ts';

/** WebSocket en mémoire : on inspecte ce qui part, on injecte ce qui arrive. */
class FauxWebSocket implements WebSocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  send(donnees: string): void {
    this.sent.push(JSON.parse(donnees) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  /** Simule l'ouverture TCP. */
  open(): void {
    this.onopen?.(null);
  }

  receive(objet: unknown): void {
    this.onmessage?.({ data: JSON.stringify(objet) });
  }

  receiveRaw(texte: string): void {
    this.onmessage?.({ data: texte });
  }

  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
}

/** Connecte un client jusqu'à `authentifie`, en répondant comme le serveur. */
async function clientAuthentifie(): Promise<{ ddp: ClientDdp; ws: FauxWebSocket }> {
  const ws = new FauxWebSocket();
  const ddp = new ClientDdp('ws://x/websocket', { createWebSocket: () => ws, timeoutMs: 200 });
  const promesse = ddp.connect('jeton-rest');
  ws.open();
  ws.receive({ msg: 'connected', session: 'sess-1' });
  // Le client envoie alors `method login`.
  await new Promise((r) => setImmediate(r));
  const login = ws.last();
  ws.receive({ msg: 'result', id: login.id, result: { id: 'u1' } });
  await promesse;
  return { ddp, ws };
}

describe('ClientDdp', () => {
  test('le handshake DDP est envoyé à l’ouverture', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton');
    ws.open();
    assert.deepEqual(ws.sent[0], { msg: 'connect', version: '1', support: ['1'] });

    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await p;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ddp.session, 's');
  });

  test('le login DDP utilise le jeton REST via `resume`', async () => {
    const { ws } = await clientAuthentifie();
    const login = ws.sent.find((m) => m.msg === 'method');
    assert.equal(login?.method, 'login');
    assert.deepEqual(login?.params, [{ resume: 'jeton-rest' }]);
  });

  test('un `failed` rejette la connexion ET laisse le client réutilisable', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('j');
    ws.open();
    ws.receive({ msg: 'failed', version: '2' });
    await assert.rejects(p, /Version DDP refusée/);
    assert.equal(ddp.state, 'closed', 'sinon toute retentative échoue sur « déjà connecté »');
    assert.equal(ws.closed, true);
  });

  test('le TIMEOUT de négociation nettoie : le client reste réutilisable', async () => {
    // Un proxy qui accepte le WebSocket mais dont le backend est mort n'enverra
    // jamais « connected » NI ne fermera la socket : sans nettoyage, l'état
    // resterait « connexion » pour toujours et le pilote de reconnexion
    // tournerait à vide sur « déjà connecté ».
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 50 });
    const p = ddp.connect('j');
    ws.open();
    await assert.rejects(p, /Pas de « connected »/);
    assert.equal(ddp.state, 'closed');
    assert.equal(ws.closed, true, 'la socket zombie est coupée');
  });

  test('fermer() pendant la négociation rejette IMMÉDIATEMENT', async () => {
    // La négociation vit hors de `attentes` : sans crochet dédié, ce scénario
    // (démontage rapide d'un écran, StrictMode) pendait jusqu'au délai. Le
    // délai d'une minute ici prouve qu'on ne passe PAS par lui.
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 60_000 });
    const p = ddp.connect('j');
    ws.open();
    ddp.close();
    await assert.rejects(p, DdpError);
    assert.equal(ddp.state, 'closed');
  });

  test('souscrire AVANT l’authentification est différé, puis établi tout seul', async () => {
    // Régression : l'ancienne API levait ici, l'écran avalait l'erreur et ne
    // retentait jamais — un salon ouvert trop tôt restait sourd à vie. C'est
    // le chemin exact d'un lancement par tap sur une notification (6.2).
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x/websocket', { createWebSocket: () => ws, timeoutMs: 200 });
    ddp.subscribe('stream-room-messages', 'rid-1');
    assert.equal(ws.sent.length, 0, "rien ne part tant qu'on n'est pas authentifié");

    const promesse = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await promesse;

    const sub = ws.sent.find((m) => m.msg === 'sub');
    assert.ok(sub, "la souscription différée part à l'authentification");
    assert.equal(sub?.name, 'stream-room-messages');
    ws.receive({ msg: 'ready', subs: [sub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('une `sub` envoie la convention des streamers et attend `ready`', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid-1');
    const sub = ws.last();
    assert.equal(sub.msg, 'sub');
    assert.equal(sub.name, 'stream-room-messages');
    assert.deepEqual(sub.params, ['rid-1', { useCollection: false, args: [] }]);
    assert.equal(ddp.subscriptionCount, 0, 'pas établie avant le `ready`');

    ws.receive({ msg: 'ready', subs: [sub.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('`souscriptionsArmees` attend le `ready` du serveur, pas un délai', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid-1');
    ddp.subscribe('stream-notify-user', 'u1/rooms-changed');
    const [avantDernier, dernier] = ws.sent.slice(-2);

    let armees = false;
    const attente = ddp.armedSubscriptions().then(() => {
      armees = true;
    });

    // Une seule des deux est prête : le raccordement ne doit PAS lire encore,
    // sinon l'autre laisse un trou entre les deux transports.
    ws.receive({ msg: 'ready', subs: [avantDernier.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(armees, false);

    ws.receive({ msg: 'ready', subs: [dernier.id] });
    await attente;
    assert.equal(armees, true);
    assert.equal(ddp.subscriptionCount, 2);
  });

  test('`souscriptionsArmees` retombe aussi sur un `nosub` — jamais de blocage', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'prive');
    const sub = ws.last();

    const attente = ddp.armedSubscriptions();
    ws.receive({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });

    await attente; // ne rejette pas : un salon refusé n'empêche pas de lire
    assert.equal(ddp.subscriptionCount, 0);
  });

  test('`souscriptionsArmees` retombe quand la socket meurt en pleine négociation', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid-1');

    const attente = ddp.armedSubscriptions();
    ws.onclose?.(null); // coupure pendant que la `sub` est en vol

    await attente;
    assert.equal(ddp.state, 'closed');
  });

  test('un `nosub` ne compte pas la souscription, mais la garde désirée', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'prive');
    const sub = ws.last();
    ws.receive({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 0);
    assert.equal(ddp.wantedSubscriptionCount, 1, 'retentée à la prochaine authentification');
  });

  test('un `changed` est routé vers les écouteurs', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const recus: DdpEvent[] = [];
    ddp.onEvent((e) => recus.push(e));

    ws.receive({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: 'rid-1', args: [{ msg: 'bonjour' }] },
    });
    assert.equal(recus.length, 1);
    assert.equal(recus[0].collection, 'stream-room-messages');
    assert.equal(recus[0].eventKey, 'rid-1');
    assert.deepEqual(recus[0].args, [{ msg: 'bonjour' }]);
  });

  test("un écouteur qui lève n'empêche pas les autres de recevoir", async () => {
    const { ddp, ws } = await clientAuthentifie();
    const recus: string[] = [];
    ddp.onEvent(() => {
      throw new Error('boum');
    });
    ddp.onEvent((e) => recus.push(e.eventKey));
    ws.receive({
      msg: 'changed',
      collection: 'c',
      fields: { eventName: 'k', args: [] },
    });
    assert.deepEqual(recus, ['k']);
  });

  test('un `changed` sans `eventName` est ignoré, pas fatal', async () => {
    const { ddp, ws } = await clientAuthentifie();
    let recus = 0;
    ddp.onEvent(() => recus++);
    ws.receive({ msg: 'changed', collection: 'c', fields: { args: [] } });
    assert.equal(recus, 0);
  });

  test('un `ping` reçoit un `pong`, avec l’`id` seulement s’il y en avait un', async () => {
    const { ws } = await clientAuthentifie();
    ws.receive({ msg: 'ping' });
    assert.deepEqual(ws.last(), { msg: 'pong' });
    ws.receive({ msg: 'ping', id: 'p1' });
    assert.deepEqual(ws.last(), { msg: 'pong', id: 'p1' });
  });

  test('un message non JSON ne fait pas planter le client', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ws.receiveRaw('<html>proxy</html>');
    assert.equal(ddp.state, 'authenticated');
  });

  test('relâcher envoie `unsub` ; relâcher deux fois est inoffensif', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.subscribe('stream-notify-user', 'u1/subscriptions-changed');
    const id = ws.last().id;
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));

    relacher();
    assert.deepEqual(ws.last(), { msg: 'unsub', id });
    assert.equal(ddp.subscriptionCount, 0);

    // Idempotente par appelant : un double appel ne vole pas la référence
    // d'un autre écran.
    const avant = ws.sent.length;
    relacher();
    assert.equal(ws.sent.length, avant);
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('relâcher PENDANT la négociation coupe la souscription dès le `ready`', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.subscribe('stream-room-messages', 'rid');
    const id = ws.last().id;
    relacher(); // l'écran ferme avant la réponse du serveur
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ws.last(), { msg: 'unsub', id }, 'ne pas laisser fuir la souscription');
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('relâcher APRÈS une coupure ne fuit pas la référence', async () => {
    // Régression : `desouscrire(id)` cherchait l'identifiant du fil, que la
    // coupure venait d'effacer — le compteur ne redescendait jamais et la
    // reconnexion aurait rejoué des salons fermés pour toujours.
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null); // la socket tombe, l'écran est toujours ouvert
    relacher(); // puis l'écran ferme
    assert.equal(ddp.wantedSubscriptionCount, 0, 'plus rien à rejouer en 5.1');
  });

  test('la fermeture de la socket laisse la négociation retomber proprement', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.onclose?.(null);
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.state, 'closed');
    assert.equal(ddp.subscriptionCount, 0);
    assert.equal(ddp.wantedSubscriptionCount, 1);
  });

  test('la sonde de vie : pong = vivant ; silence = socket nettoyée et perte notifiée', async () => {
    const vivant = await clientAuthentifie();
    const p1 = vivant.ddp.checkAlive();
    vivant.ws.receive({ msg: 'pong', id: vivant.ws.last().id });
    assert.equal(await p1, true);
    assert.equal(vivant.ddp.state, 'authenticated');

    // Socket à moitié morte : jamais de pong, jamais de close.
    const zombie = await clientAuthentifie(); // délai 200 ms
    let pertes = 0;
    zombie.ddp.onLoss(() => pertes++);
    assert.equal(await zombie.ddp.checkAlive(), false);
    assert.equal(zombie.ddp.state, 'closed', 'la socket morte est nettoyée');
    assert.equal(pertes, 1, 'le pilote de reconnexion est prévenu');
  });

  test('surPerte prévient sur une coupure — jamais sur fermer()', async () => {
    // C'est le signal du pilote de reconnexion : le notifier sur `fermer()`
    // déclencherait une reconnexion juste après la déconnexion volontaire.
    const premiere = await clientAuthentifie();
    let pertes = 0;
    premiere.ddp.onLoss(() => pertes++);
    premiere.ws.onclose?.(null);
    assert.equal(pertes, 1);

    const seconde = await clientAuthentifie();
    let pertesVolontaires = 0;
    seconde.ddp.onLoss(() => pertesVolontaires++);
    seconde.ddp.close();
    assert.equal(pertesVolontaires, 0);
  });

  test('à la reconnexion, les souscriptions désirées sont rejouées', async () => {
    // Fondation de l'étape 5.1 : la coupure efface les identifiants du fil,
    // pas les intentions. Une nouvelle authentification rétablit tout.
    const sockets: FauxWebSocket[] = [];
    const ddp = new ClientDdp('ws://x/websocket', {
      createWebSocket: () => {
        const ws = new FauxWebSocket();
        sockets.push(ws);
        return ws;
      },
      timeoutMs: 200,
    });

    const p1 = ddp.connect('jeton');
    sockets[0].open();
    sockets[0].receive({ msg: 'connected', session: 's1' });
    await new Promise((r) => setImmediate(r));
    sockets[0].receive({ msg: 'result', id: sockets[0].last().id, result: {} });
    await p1;

    ddp.subscribe('stream-room-messages', 'rid');
    sockets[0].receive({ msg: 'ready', subs: [sockets[0].last().id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);

    sockets[0].onclose?.(null); // coupure
    assert.equal(ddp.subscriptionCount, 0);

    const p2 = ddp.connect('jeton');
    sockets[1].open();
    sockets[1].receive({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].receive({ msg: 'result', id: sockets[1].last().id, result: {} });
    await p2;

    const resub = sockets[1].sent.find((m) => m.msg === 'sub');
    assert.ok(resub, 'la souscription repart sans que personne ne la redemande');
    sockets[1].receive({ msg: 'ready', subs: [resub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('un login refusé ferme la socket et laisse le client réutilisable', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton-mort');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, error: { error: 403, reason: 'login denied' } });

    await assert.rejects(p, /Méthode refusée/);
    assert.equal(ddp.state, 'closed', "sinon un connecter() ultérieur lèverait « déjà connecté »");
    assert.equal(ws.closed, true, 'la socket ne doit pas fuir');
  });

  test('une socket morte pendant le login ne notifie la perte QU’UNE FOIS', async () => {
    // `onclose` nettoie et rejette l'attente du login ; le `catch` de
    // `connecter()` rappelle `nettoyer()`. Sans idempotence, tout abonné
    // (compteur de coupures, bandeau hors ligne, métrique) compte double, et
    // le second passage réémet l'événement sur un objet déjà vidé.
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    let pertes = 0;
    ddp.onLoss(() => pertes++);
    const p = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r)); // le `method login` est parti
    ws.onclose?.(null); // la socket meurt AVANT la réponse au login

    await assert.rejects(p);
    assert.equal(pertes, 1, 'une coupure, un événement');
    assert.equal(ddp.state, 'closed');
  });

  test('`verifierVie` pendant la NÉGOCIATION ne sonde pas et ne tue pas la socket', async () => {
    // Sondé sur un vrai Rocket.Chat 8.5 : un `ping` envoyé avant le `connect`
    // reçoit `{msg:'error', reason:'Must connect first'}` — jamais de `pong`.
    // L'attente pendrait donc jusqu'à son délai, et le `catch` fermerait une
    // socket qui, entre-temps, a fini son login et rejoué ses souscriptions.
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 60 });
    const p = ddp.connect('jeton');
    ws.open();
    assert.equal(ddp.state, 'connecting');

    const avant = ws.sent.length;
    assert.equal(await ddp.checkAlive(), false, 'une négociation a déjà son propre délai');
    assert.equal(ws.sent.length, avant, 'aucun ping ne part');

    // La négociation aboutit normalement, la socket est intacte.
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: {} });
    await p;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ws.closed, false, 'la sonde prématurée n’a rien fermé');
  });

  test('`verifierVie` sonde dès l’état « connecte », avant même le login', async () => {
    // Vérifié sur le banc 8.5.1 : `connect` puis `ping` sans login → `pong`.
    // La garde ne doit donc pas être plus stricte que le serveur.
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { createWebSocket: () => ws, timeoutMs: 200 });
    const p = ddp.connect('jeton');
    ws.open();
    ws.receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.state, 'connected');

    const sonde = ddp.checkAlive();
    const ping = ws.sent.filter((m) => m.msg === 'ping').at(-1);
    assert.ok(ping, 'la sonde part');
    ws.receive({ msg: 'pong', id: ping.id });
    assert.equal(await sonde, true);

    ws.receive({ msg: 'result', id: ws.sent.find((m) => m.msg === 'method')?.id, result: {} });
    await p;
  });

  test('un `msg: error` rejette l’attente fautive au lieu de la laisser expirer', async () => {
    // Forme relevée sur le banc 8.5.1 :
    // {"msg":"error","reason":"Must connect first","offendingMessage":{"msg":"ping","id":"v1"}}
    // Sans ce cas, le message est avalé et l'appelant attend `delaiMs` pour
    // rien — c'est ce silence qui rendait la sonde prématurée destructrice.
    const { ddp, ws } = await clientAuthentifie(); // délai 200 ms
    const sonde = ddp.checkAlive();
    const id = ws.last().id;

    ws.receive({ msg: 'error', reason: 'Must connect first', offendingMessage: { msg: 'ping', id } });

    // Sans attendre les 200 ms du délai : la réponse doit être immédiate.
    assert.equal(await Promise.race([sonde, new Promise((r) => setTimeout(() => r('pendante'), 60))]), false);
  });

  test('un `msg: error` sans `offendingMessage` exploitable est ignoré, pas fatal', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ws.receive({ msg: 'error', reason: 'Bad request' });
    assert.equal(ddp.state, 'authenticated');
  });

  test('deux souscriptions au même stream ne produisent qu’une `sub` sur le fil', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    const avant = ws.sent.length;
    ddp.subscribe('stream-room-messages', 'rid');
    assert.equal(ws.sent.length, avant, 'aucune `sub` supplémentaire ne part');
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('deux `souscrire` du même tick ne produisent qu’une `sub` sur le fil', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid');
    ddp.subscribe('stream-room-messages', 'rid');
    const subs = ws.sent.filter((m) => m.msg === 'sub');
    assert.equal(subs.length, 1, 'la déduplication doit valoir aussi pour les `sub` en vol');

    ws.receive({ msg: 'ready', subs: [subs[0].id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.subscriptionCount, 1);
  });

  test('`unsub` n’est envoyé qu’au départ du dernier appelant', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher1 = ddp.subscribe('stream-room-messages', 'rid');
    const id = ws.last().id;
    ws.receive({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    const relacher2 = ddp.subscribe('stream-room-messages', 'rid');

    relacher1();
    assert.notEqual(ws.last().msg, 'unsub', 'un observateur reste');
    assert.equal(ddp.subscriptionCount, 1);

    relacher2();
    assert.deepEqual(ws.last(), { msg: 'unsub', id });
    assert.equal(ddp.subscriptionCount, 0);
  });

  test('les souscriptions désirées survivent à la chute de la socket', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.subscribe('stream-room-messages', 'rid');
    ws.receive({ msg: 'ready', subs: [ws.last().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null);
    assert.equal(ddp.subscriptionCount, 0, 'plus rien sur le fil');
    assert.equal(ddp.wantedSubscriptionCount, 1, "l'étape 5.1 doit pouvoir la rejouer");

    ddp.reset();
    assert.equal(ddp.wantedSubscriptionCount, 0);
  });

  test('le `close` d’une socket abandonnée ne casse pas la connexion suivante', async () => {
    // Bug trouvé en intégration : après un login refusé, l'`onclose` de
    // l'ancienne socket arrivait APRÈS l'ouverture de la nouvelle et remettait
    // `this.ws` à null. Le `connect` ne partait jamais, et la reconnexion
    // expirait sans explication.
    const sockets: FauxWebSocket[] = [];
    const ddp = new ClientDdp('ws://x', {
      createWebSocket: () => {
        const ws = new FauxWebSocket();
        sockets.push(ws);
        return ws;
      },
      timeoutMs: 200,
    });

    const p1 = ddp.connect('jeton-mort');
    sockets[0].open();
    sockets[0].receive({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    sockets[0].receive({ msg: 'result', id: sockets[0].last().id, error: { error: 403 } });
    await assert.rejects(p1);

    const p2 = ddp.connect('bon-jeton');
    sockets[1].open();
    // L'ancienne socket signale sa fermeture, en retard.
    sockets[0].onclose?.(null);

    sockets[1].receive({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].receive({ msg: 'result', id: sockets[1].last().id, result: {} });
    await p2;
    assert.equal(ddp.state, 'authenticated');
    assert.equal(ddp.session, 's2');
  });

  test('une `sub` sans réponse expire au lieu de pendre, et reste désirée', async () => {
    const { ddp } = await clientAuthentifie(); // délai de 200 ms
    ddp.subscribe('stream-room-messages', 'rid');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ddp.subscriptionCount, 0, 'jamais établie');
    assert.equal(ddp.wantedSubscriptionCount, 1, 'retentée à la prochaine authentification');
  });
});

/**
 * Une socket peut mourir sans que `onclose` ne soit JAMAIS appelé (FIN reçu,
 * CLOSE-WAIT côté OS, rien au JS). Sans chien de garde, le client se croit
 * authentifié pour toujours et plus aucun message n'arrive.
 */
describe('chien de garde du silence', () => {
  /** Comme `clientAuthentifie`, mais avec des seuils de garde miniatures. */
  async function clientSousGarde(): Promise<{ ddp: ClientDdp; ws: FauxWebSocket }> {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x/websocket', {
      createWebSocket: () => ws,
      timeoutMs: 120,
      silenceMaxMs: 60,
      watchdogMs: 20,
    });
    const promesse = ddp.connect('jeton-rest');
    ws.open();
    ws.receive({ msg: 'connected', session: 'sess-1' });
    await new Promise((r) => setImmediate(r));
    ws.receive({ msg: 'result', id: ws.last().id, result: { id: 'u1' } });
    await promesse;
    return { ddp, ws };
  }

  test('une socket muette est SONDÉE : le ping part tout seul', async () => {
    const { ddp, ws } = await clientSousGarde();
    const avant = ws.sent.length;

    await new Promise((r) => setTimeout(r, 110)); // dépasse le silence toléré

    const pings = ws.sent.slice(avant).filter((m) => m.msg === 'ping');
    assert.ok(pings.length >= 1, `le garde doit sonder, vu ${pings.length} ping`);
    ddp.close();
  });

  test('sans pong, la socket est déclarée morte et `surPerte` réveille le pilote', async () => {
    const { ddp, ws } = await clientSousGarde();
    let pertes = 0;
    ddp.onLoss(() => pertes++);

    // Silence total : ni trafic, ni réponse à la sonde.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(ddp.state, 'closed', 'la socket morte est nettoyée');
    assert.equal(pertes, 1, 'la perte est signalée — sans elle, rien ne reconnecte');
    assert.ok(ws.closed, 'la socket est refermée côté client');
  });

  test('un serveur qui ping REPOUSSE la garde — pas de sonde sur socket vivante', async () => {
    const { ddp, ws } = await clientSousGarde();
    const avant = ws.sent.length;

    // Le serveur tient son rythme : un ping avant chaque échéance.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40));
      ws.receive({ msg: 'ping' });
    }

    const sondes = ws.sent.slice(avant).filter((m) => m.msg === 'ping');
    assert.equal(sondes.length, 0, 'aucune sonde : le trafic serveur suffit');
    assert.equal(ddp.state, 'authenticated');
    ddp.close();
  });

  test('N’IMPORTE QUEL message compte comme trafic, pas seulement un ping', async () => {
    const { ddp, ws } = await clientSousGarde();
    const avant = ws.sent.length;

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40));
      ws.receive({
        msg: 'changed',
        collection: 'stream-room-messages',
        fields: { eventName: 'rid', args: [{ _id: `m${i}` }] },
      });
    }

    assert.equal(ws.sent.slice(avant).filter((m) => m.msg === 'ping').length, 0);
    assert.equal(ddp.state, 'authenticated');
    ddp.close();
  });

  test('`fermer()` arrête la garde — pas de sonde sur un client rangé', async () => {
    const { ddp, ws } = await clientSousGarde();
    ddp.close();
    const avant = ws.sent.length;

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(ws.sent.length, avant, 'plus rien ne part après fermeture');
  });
});
