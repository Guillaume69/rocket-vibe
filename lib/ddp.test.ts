import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientDdp, ErreurDdp, type Evenement, type WebSocketLike } from './ddp.ts';

/** WebSocket en mémoire : on inspecte ce qui part, on injecte ce qui arrive. */
class FauxWebSocket implements WebSocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  readonly envoyes: Record<string, unknown>[] = [];
  ferme = false;

  send(donnees: string): void {
    this.envoyes.push(JSON.parse(donnees) as Record<string, unknown>);
  }

  close(): void {
    this.ferme = true;
  }

  /** Simule l'ouverture TCP. */
  ouvrir(): void {
    this.onopen?.(null);
  }

  recevoir(objet: unknown): void {
    this.onmessage?.({ data: JSON.stringify(objet) });
  }

  recevoirBrut(texte: string): void {
    this.onmessage?.({ data: texte });
  }

  dernier(): Record<string, unknown> {
    return this.envoyes[this.envoyes.length - 1];
  }
}

/** Connecte un client jusqu'à `authentifie`, en répondant comme le serveur. */
async function clientAuthentifie(): Promise<{ ddp: ClientDdp; ws: FauxWebSocket }> {
  const ws = new FauxWebSocket();
  const ddp = new ClientDdp('ws://x/websocket', { creerWebSocket: () => ws, delaiMs: 200 });
  const promesse = ddp.connecter('jeton-rest');
  ws.ouvrir();
  ws.recevoir({ msg: 'connected', session: 'sess-1' });
  // Le client envoie alors `method login`.
  await new Promise((r) => setImmediate(r));
  const login = ws.dernier();
  ws.recevoir({ msg: 'result', id: login.id, result: { id: 'u1' } });
  await promesse;
  return { ddp, ws };
}

describe('ClientDdp', () => {
  test('le handshake DDP est envoyé à l’ouverture', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { creerWebSocket: () => ws, delaiMs: 200 });
    const p = ddp.connecter('jeton');
    ws.ouvrir();
    assert.deepEqual(ws.envoyes[0], { msg: 'connect', version: '1', support: ['1'] });

    ws.recevoir({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.recevoir({ msg: 'result', id: ws.dernier().id, result: {} });
    await p;
    assert.equal(ddp.etat, 'authentifie');
    assert.equal(ddp.session, 's');
  });

  test('le login DDP utilise le jeton REST via `resume`', async () => {
    const { ws } = await clientAuthentifie();
    const login = ws.envoyes.find((m) => m.msg === 'method');
    assert.equal(login?.method, 'login');
    assert.deepEqual(login?.params, [{ resume: 'jeton-rest' }]);
  });

  test('un `failed` rejette la connexion', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { creerWebSocket: () => ws, delaiMs: 200 });
    const p = ddp.connecter('j');
    ws.ouvrir();
    ws.recevoir({ msg: 'failed', version: '2' });
    await assert.rejects(p, /Version DDP refusée/);
  });

  test('fermer() pendant la négociation rejette IMMÉDIATEMENT', async () => {
    // La négociation vit hors de `attentes` : sans crochet dédié, ce scénario
    // (démontage rapide d'un écran, StrictMode) pendait jusqu'au délai. Le
    // délai d'une minute ici prouve qu'on ne passe PAS par lui.
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { creerWebSocket: () => ws, delaiMs: 60_000 });
    const p = ddp.connecter('j');
    ws.ouvrir();
    ddp.fermer();
    await assert.rejects(p, ErreurDdp);
    assert.equal(ddp.etat, 'ferme');
  });

  test('souscrire AVANT l’authentification est différé, puis établi tout seul', async () => {
    // Régression : l'ancienne API levait ici, l'écran avalait l'erreur et ne
    // retentait jamais — un salon ouvert trop tôt restait sourd à vie. C'est
    // le chemin exact d'un lancement par tap sur une notification (6.2).
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x/websocket', { creerWebSocket: () => ws, delaiMs: 200 });
    ddp.souscrire('stream-room-messages', 'rid-1');
    assert.equal(ws.envoyes.length, 0, "rien ne part tant qu'on n'est pas authentifié");

    const promesse = ddp.connecter('jeton');
    ws.ouvrir();
    ws.recevoir({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.recevoir({ msg: 'result', id: ws.dernier().id, result: {} });
    await promesse;

    const sub = ws.envoyes.find((m) => m.msg === 'sub');
    assert.ok(sub, "la souscription différée part à l'authentification");
    assert.equal(sub?.name, 'stream-room-messages');
    ws.recevoir({ msg: 'ready', subs: [sub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('une `sub` envoie la convention des streamers et attend `ready`', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'rid-1');
    const sub = ws.dernier();
    assert.equal(sub.msg, 'sub');
    assert.equal(sub.name, 'stream-room-messages');
    assert.deepEqual(sub.params, ['rid-1', { useCollection: false, args: [] }]);
    assert.equal(ddp.nombreSouscriptions, 0, 'pas établie avant le `ready`');

    ws.recevoir({ msg: 'ready', subs: [sub.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('un `nosub` ne compte pas la souscription, mais la garde désirée', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'prive');
    const sub = ws.dernier();
    ws.recevoir({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 0);
    assert.equal(ddp.nombreSouscriptionsDesirees, 1, 'retentée à la prochaine authentification');
  });

  test('un `changed` est routé vers les écouteurs', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const recus: Evenement[] = [];
    ddp.surEvenement((e) => recus.push(e));

    ws.recevoir({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: 'rid-1', args: [{ msg: 'bonjour' }] },
    });
    assert.equal(recus.length, 1);
    assert.equal(recus[0].collection, 'stream-room-messages');
    assert.equal(recus[0].cleEvenement, 'rid-1');
    assert.deepEqual(recus[0].args, [{ msg: 'bonjour' }]);
  });

  test("un écouteur qui lève n'empêche pas les autres de recevoir", async () => {
    const { ddp, ws } = await clientAuthentifie();
    const recus: string[] = [];
    ddp.surEvenement(() => {
      throw new Error('boum');
    });
    ddp.surEvenement((e) => recus.push(e.cleEvenement));
    ws.recevoir({
      msg: 'changed',
      collection: 'c',
      fields: { eventName: 'k', args: [] },
    });
    assert.deepEqual(recus, ['k']);
  });

  test('un `changed` sans `eventName` est ignoré, pas fatal', async () => {
    const { ddp, ws } = await clientAuthentifie();
    let recus = 0;
    ddp.surEvenement(() => recus++);
    ws.recevoir({ msg: 'changed', collection: 'c', fields: { args: [] } });
    assert.equal(recus, 0);
  });

  test('un `ping` reçoit un `pong`, avec l’`id` seulement s’il y en avait un', async () => {
    const { ws } = await clientAuthentifie();
    ws.recevoir({ msg: 'ping' });
    assert.deepEqual(ws.dernier(), { msg: 'pong' });
    ws.recevoir({ msg: 'ping', id: 'p1' });
    assert.deepEqual(ws.dernier(), { msg: 'pong', id: 'p1' });
  });

  test('un message non JSON ne fait pas planter le client', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ws.recevoirBrut('<html>proxy</html>');
    assert.equal(ddp.etat, 'authentifie');
  });

  test('relâcher envoie `unsub` ; relâcher deux fois est inoffensif', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.souscrire('stream-notify-user', 'u1/subscriptions-changed');
    const id = ws.dernier().id;
    ws.recevoir({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));

    relacher();
    assert.deepEqual(ws.dernier(), { msg: 'unsub', id });
    assert.equal(ddp.nombreSouscriptions, 0);

    // Idempotente par appelant : un double appel ne vole pas la référence
    // d'un autre écran.
    const avant = ws.envoyes.length;
    relacher();
    assert.equal(ws.envoyes.length, avant);
    assert.equal(ddp.nombreSouscriptionsDesirees, 0);
  });

  test('relâcher PENDANT la négociation coupe la souscription dès le `ready`', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.souscrire('stream-room-messages', 'rid');
    const id = ws.dernier().id;
    relacher(); // l'écran ferme avant la réponse du serveur
    ws.recevoir({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ws.dernier(), { msg: 'unsub', id }, 'ne pas laisser fuir la souscription');
    assert.equal(ddp.nombreSouscriptionsDesirees, 0);
  });

  test('relâcher APRÈS une coupure ne fuit pas la référence', async () => {
    // Régression : `desouscrire(id)` cherchait l'identifiant du fil, que la
    // coupure venait d'effacer — le compteur ne redescendait jamais et la
    // reconnexion aurait rejoué des salons fermés pour toujours.
    const { ddp, ws } = await clientAuthentifie();
    const relacher = ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null); // la socket tombe, l'écran est toujours ouvert
    relacher(); // puis l'écran ferme
    assert.equal(ddp.nombreSouscriptionsDesirees, 0, 'plus rien à rejouer en 5.1');
  });

  test('la fermeture de la socket laisse la négociation retomber proprement', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'rid');
    ws.onclose?.(null);
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.etat, 'ferme');
    assert.equal(ddp.nombreSouscriptions, 0);
    assert.equal(ddp.nombreSouscriptionsDesirees, 1);
  });

  test('à la reconnexion, les souscriptions désirées sont rejouées', async () => {
    // Fondation de l'étape 5.1 : la coupure efface les identifiants du fil,
    // pas les intentions. Une nouvelle authentification rétablit tout.
    const sockets: FauxWebSocket[] = [];
    const ddp = new ClientDdp('ws://x/websocket', {
      creerWebSocket: () => {
        const ws = new FauxWebSocket();
        sockets.push(ws);
        return ws;
      },
      delaiMs: 200,
    });

    const p1 = ddp.connecter('jeton');
    sockets[0].ouvrir();
    sockets[0].recevoir({ msg: 'connected', session: 's1' });
    await new Promise((r) => setImmediate(r));
    sockets[0].recevoir({ msg: 'result', id: sockets[0].dernier().id, result: {} });
    await p1;

    ddp.souscrire('stream-room-messages', 'rid');
    sockets[0].recevoir({ msg: 'ready', subs: [sockets[0].dernier().id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 1);

    sockets[0].onclose?.(null); // coupure
    assert.equal(ddp.nombreSouscriptions, 0);

    const p2 = ddp.connecter('jeton');
    sockets[1].ouvrir();
    sockets[1].recevoir({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].recevoir({ msg: 'result', id: sockets[1].dernier().id, result: {} });
    await p2;

    const resub = sockets[1].envoyes.find((m) => m.msg === 'sub');
    assert.ok(resub, 'la souscription repart sans que personne ne la redemande');
    sockets[1].recevoir({ msg: 'ready', subs: [resub?.id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('un login refusé ferme la socket et laisse le client réutilisable', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { creerWebSocket: () => ws, delaiMs: 200 });
    const p = ddp.connecter('jeton-mort');
    ws.ouvrir();
    ws.recevoir({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    ws.recevoir({ msg: 'result', id: ws.dernier().id, error: { error: 403, reason: 'login denied' } });

    await assert.rejects(p, /Méthode refusée/);
    assert.equal(ddp.etat, 'ferme', "sinon un connecter() ultérieur lèverait « déjà connecté »");
    assert.equal(ws.ferme, true, 'la socket ne doit pas fuir');
  });

  test('deux souscriptions au même stream ne produisent qu’une `sub` sur le fil', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    await new Promise((r) => setImmediate(r));

    const avant = ws.envoyes.length;
    ddp.souscrire('stream-room-messages', 'rid');
    assert.equal(ws.envoyes.length, avant, 'aucune `sub` supplémentaire ne part');
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('deux `souscrire` du même tick ne produisent qu’une `sub` sur le fil', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'rid');
    ddp.souscrire('stream-room-messages', 'rid');
    const subs = ws.envoyes.filter((m) => m.msg === 'sub');
    assert.equal(subs.length, 1, 'la déduplication doit valoir aussi pour les `sub` en vol');

    ws.recevoir({ msg: 'ready', subs: [subs[0].id] });
    await new Promise((r) => setImmediate(r));
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('`unsub` n’est envoyé qu’au départ du dernier appelant', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const relacher1 = ddp.souscrire('stream-room-messages', 'rid');
    const id = ws.dernier().id;
    ws.recevoir({ msg: 'ready', subs: [id] });
    await new Promise((r) => setImmediate(r));
    const relacher2 = ddp.souscrire('stream-room-messages', 'rid');

    relacher1();
    assert.notEqual(ws.dernier().msg, 'unsub', 'un observateur reste');
    assert.equal(ddp.nombreSouscriptions, 1);

    relacher2();
    assert.deepEqual(ws.dernier(), { msg: 'unsub', id });
    assert.equal(ddp.nombreSouscriptions, 0);
  });

  test('les souscriptions désirées survivent à la chute de la socket', async () => {
    const { ddp, ws } = await clientAuthentifie();
    ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    await new Promise((r) => setImmediate(r));

    ws.onclose?.(null);
    assert.equal(ddp.nombreSouscriptions, 0, 'plus rien sur le fil');
    assert.equal(ddp.nombreSouscriptionsDesirees, 1, "l'étape 5.1 doit pouvoir la rejouer");

    ddp.reinitialiser();
    assert.equal(ddp.nombreSouscriptionsDesirees, 0);
  });

  test('le `close` d’une socket abandonnée ne casse pas la connexion suivante', async () => {
    // Bug trouvé en intégration : après un login refusé, l'`onclose` de
    // l'ancienne socket arrivait APRÈS l'ouverture de la nouvelle et remettait
    // `this.ws` à null. Le `connect` ne partait jamais, et la reconnexion
    // expirait sans explication.
    const sockets: FauxWebSocket[] = [];
    const ddp = new ClientDdp('ws://x', {
      creerWebSocket: () => {
        const ws = new FauxWebSocket();
        sockets.push(ws);
        return ws;
      },
      delaiMs: 200,
    });

    const p1 = ddp.connecter('jeton-mort');
    sockets[0].ouvrir();
    sockets[0].recevoir({ msg: 'connected', session: 's' });
    await new Promise((r) => setImmediate(r));
    sockets[0].recevoir({ msg: 'result', id: sockets[0].dernier().id, error: { error: 403 } });
    await assert.rejects(p1);

    const p2 = ddp.connecter('bon-jeton');
    sockets[1].ouvrir();
    // L'ancienne socket signale sa fermeture, en retard.
    sockets[0].onclose?.(null);

    sockets[1].recevoir({ msg: 'connected', session: 's2' });
    await new Promise((r) => setImmediate(r));
    sockets[1].recevoir({ msg: 'result', id: sockets[1].dernier().id, result: {} });
    await p2;
    assert.equal(ddp.etat, 'authentifie');
    assert.equal(ddp.session, 's2');
  });

  test('une `sub` sans réponse expire au lieu de pendre, et reste désirée', async () => {
    const { ddp } = await clientAuthentifie(); // délai de 200 ms
    ddp.souscrire('stream-room-messages', 'rid');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ddp.nombreSouscriptions, 0, 'jamais établie');
    assert.equal(ddp.nombreSouscriptionsDesirees, 1, 'retentée à la prochaine authentification');
  });
});
