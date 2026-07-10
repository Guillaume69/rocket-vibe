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

  test('souscrire avant authentification est refusé côté client', async () => {
    const ws = new FauxWebSocket();
    const ddp = new ClientDdp('ws://x', { creerWebSocket: () => ws });
    await assert.rejects(ddp.souscrire('stream-room-messages', 'rid'), /avant authentification/);
  });

  test('une `sub` envoie la convention des streamers et attend `ready`', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-room-messages', 'rid-1');
    const sub = ws.dernier();
    assert.equal(sub.msg, 'sub');
    assert.equal(sub.name, 'stream-room-messages');
    assert.deepEqual(sub.params, ['rid-1', { useCollection: false, args: [] }]);

    ws.recevoir({ msg: 'ready', subs: [sub.id] });
    const id = await p;
    assert.equal(id, sub.id);
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('un `nosub` rejette la souscription et ne la compte pas', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-room-messages', 'prive');
    const sub = ws.dernier();
    ws.recevoir({ msg: 'nosub', id: sub.id, error: { error: 'not-allowed' } });
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof ErreurDdp);
      assert.deepEqual(e.details, { error: 'not-allowed' });
      return true;
    });
    assert.equal(ddp.nombreSouscriptions, 0);
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

  test('desouscrire envoie `unsub` et décrémente le compteur', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-notify-user', 'u1/subscriptions-changed');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    const id = await p;

    await ddp.desouscrire(id);
    assert.deepEqual(ws.dernier(), { msg: 'unsub', id });
    assert.equal(ddp.nombreSouscriptions, 0);

    // Un second `unsub` sur le même id ne doit rien renvoyer au serveur.
    const avant = ws.envoyes.length;
    await ddp.desouscrire(id);
    assert.equal(ws.envoyes.length, avant);
  });

  test('la fermeture de la socket rejette les promesses en vol', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-room-messages', 'rid');
    ws.onclose?.(null);
    await assert.rejects(p, /Socket fermée/);
    assert.equal(ddp.etat, 'ferme');
    assert.equal(ddp.nombreSouscriptions, 0);
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
    const p1 = ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    const id1 = await p1;

    const avant = ws.envoyes.length;
    const id2 = await ddp.souscrire('stream-room-messages', 'rid');
    assert.equal(id2, id1, 'le même identifiant est réutilisé');
    assert.equal(ws.envoyes.length, avant, 'aucune `sub` supplémentaire ne part');
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('deux `souscrire` du même tick ne produisent qu’une `sub` sur le fil', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p1 = ddp.souscrire('stream-room-messages', 'rid');
    const p2 = ddp.souscrire('stream-room-messages', 'rid');
    const subs = ws.envoyes.filter((m) => m.msg === 'sub');
    assert.equal(subs.length, 1, 'la déduplication doit valoir aussi pour les `sub` en vol');

    ws.recevoir({ msg: 'ready', subs: [subs[0].id] });
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, b);
    assert.equal(ddp.nombreSouscriptions, 1);
  });

  test('`unsub` n’est envoyé qu’au départ du dernier appelant', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    const id = await p;
    await ddp.souscrire('stream-room-messages', 'rid');

    await ddp.desouscrire(id);
    assert.notEqual(ws.dernier().msg, 'unsub', 'un observateur reste');
    assert.equal(ddp.nombreSouscriptions, 1);

    await ddp.desouscrire(id);
    assert.deepEqual(ws.dernier(), { msg: 'unsub', id });
    assert.equal(ddp.nombreSouscriptions, 0);
  });

  test('les souscriptions désirées survivent à la chute de la socket', async () => {
    const { ddp, ws } = await clientAuthentifie();
    const p = ddp.souscrire('stream-room-messages', 'rid');
    ws.recevoir({ msg: 'ready', subs: [ws.dernier().id] });
    await p;

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

  test('une `sub` sans réponse expire au lieu de pendre indéfiniment', async () => {
    const { ddp } = await clientAuthentifie();
    await assert.rejects(ddp.souscrire('stream-room-messages', 'rid'), /ni réponse ni erreur/);
  });
});
