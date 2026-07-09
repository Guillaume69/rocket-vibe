#!/usr/bin/env node
// Spike DDP jetable — étape 1.7.
//
//   node scripts/spike-ddp.mjs
//
// Prouve le chemin temps réel de bout en bout contre le serveur Docker local,
// et tranche l'incertitude n°2 de ROADMAP.md §7 : les streams privés
// exigent-ils une session DDP authentifiée (`method login {resume}`) en plus
// de l'authentification REST ?
//
// Protocole : on ouvre DEUX connexions WebSocket. La première ne fait PAS de
// login DDP et tente de s'abonner à stream-room-messages sur un salon privé ;
// la seconde fait le login puis s'abonne aux mêmes streams. On poste ensuite
// un message via REST et on observe qui reçoit quoi.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le WebSocket GLOBAL de Node 22+, volontairement : c'est la même API
// navigateur (onopen/onmessage/onerror) que celle de React Native. Le spike
// valide donc exactement le code qu'utilisera l'app — pas celui de `ws`.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`${path} introuvable. Copie docker/.env.example en docker/.env.`);
    process.exit(1);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = readEnvFile(join(ROOT, 'docker', '.env'));
if (!env.ROOT_URL) {
  console.error('ROOT_URL absent de docker/.env.');
  process.exit(1);
}
const BASE = env.ROOT_URL.replace(/\/$/, '');
const WS_URL = `${BASE.replace(/^http/, 'ws')}/websocket`;

// ---------------------------------------------------------------------------
// REST : login admin + repérage des salons de test.
// ---------------------------------------------------------------------------
async function rest(method, endpoint, auth, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    headers['X-Auth-Token'] = auth.token;
    headers['X-User-Id'] = auth.userId;
  }
  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`${endpoint} -> ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Mini-client DDP jetable. Assez pour connect / login / sub / événements.
// ---------------------------------------------------------------------------
class SpikeDDP {
  constructor(nom) {
    this.nom = nom;
    this.compteur = 0;
    this.attentes = new Map(); // id -> {resolve, reject} des sub/method en vol
    this.evenements = []; // messages `changed` reçus sur les streams
    this.journal = [];
  }

  log(...args) {
    const ligne = `[${this.nom}] ${args.join(' ')}`;
    this.journal.push(ligne);
    console.log(ligne);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.onerror = (e) => reject(new Error(`websocket : ${e.message ?? 'erreur'}`));
      this.ws.onmessage = (e) => this.recevoir(JSON.parse(String(e.data)), resolve);
      this.ws.onopen = () => {
        this.envoyer({ msg: 'connect', version: '1', support: ['1'] });
      };
    });
  }

  envoyer(objet) {
    this.ws.send(JSON.stringify(objet));
  }

  recevoir(m, onConnected) {
    switch (m.msg) {
      case 'connected':
        this.log('session DDP ouverte :', m.session);
        onConnected?.(m.session);
        break;
      case 'ping':
        this.envoyer({ msg: 'pong', ...(m.id ? { id: m.id } : {}) });
        break;
      case 'result': {
        const attente = this.attentes.get(m.id);
        if (attente) {
          this.attentes.delete(m.id);
          m.error ? attente.reject(new Error(JSON.stringify(m.error))) : attente.resolve(m.result);
        }
        break;
      }
      case 'ready':
        for (const id of m.subs) {
          const attente = this.attentes.get(id);
          if (attente) {
            this.attentes.delete(id);
            attente.resolve('ready');
          }
        }
        break;
      case 'nosub': {
        const attente = this.attentes.get(m.id);
        if (attente) {
          this.attentes.delete(m.id);
          attente.reject(new Error(`nosub: ${JSON.stringify(m.error ?? '(sans erreur)')}`));
        }
        break;
      }
      case 'changed':
        // Format streamer : collection = nom du stream, fields.eventName = clé,
        // fields.args = charge utile.
        this.evenements.push(m);
        this.log(
          'événement :',
          m.collection,
          '|',
          m.fields?.eventName,
          '|',
          JSON.stringify(m.fields?.args?.[0]?.msg ?? m.fields?.args?.[0] ?? null).slice(0, 80),
        );
        break;
      default:
        // updated, added… sans intérêt pour le spike.
        break;
    }
  }

  appeler(methode, ...params) {
    const id = `m${++this.compteur}`;
    return new Promise((resolve, reject) => {
      this.attentes.set(id, { resolve, reject });
      this.envoyer({ msg: 'method', id, method: methode, params });
      setTimeout(() => {
        if (this.attentes.delete(id)) reject(new Error(`méthode ${methode} : pas de result en 5 s`));
      }, 5000);
    });
  }

  souscrire(nom, ...params) {
    const id = `s${++this.compteur}`;
    return new Promise((resolve, reject) => {
      this.attentes.set(id, { resolve, reject });
      this.envoyer({ msg: 'sub', id, name: nom, params });
      setTimeout(() => {
        if (this.attentes.delete(id)) reject(new Error(`sub ${nom} : ni ready ni nosub en 5 s`));
      }, 5000);
    });
  }

  fermer() {
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// Le protocole du spike.
// ---------------------------------------------------------------------------
async function main() {
  console.log(`serveur : ${BASE}\nwebsocket : ${WS_URL}\n`);

  const admin = await rest('POST', 'login', null, {
    user: env.ADMIN_USERNAME,
    password: env.ADMIN_PASS,
  });
  const auth = { token: admin.data.authToken, userId: admin.data.userId };
  console.log(`REST : connecté comme ${env.ADMIN_USERNAME}\n`);

  const prive = await rest('GET', 'groups.info?roomName=test-prive', auth);
  const publicCh = await rest('GET', 'channels.info?roomName=test-public', auth);
  const ridPrive = prive.group._id;
  const ridPublic = publicCh.channel._id;
  console.log(`salon privé  : test-prive  (${ridPrive})`);
  console.log(`salon public : test-public (${ridPublic})\n`);

  const verdicts = [];
  // Une sub anonyme ACCEPTÉE sur un salon privé doit faire échouer le spike,
  // même si aucun événement ne fuit pendant la fenêtre d'observation.
  let subAnonymePriveeAcceptee = false;

  // --- Connexion A : PAS de login DDP -------------------------------------
  const anonyme = new SpikeDDP('anonyme');
  await anonyme.connect();

  try {
    await anonyme.souscrire('stream-room-messages', ridPrive, { useCollection: false, args: [] });
    subAnonymePriveeAcceptee = true;
    verdicts.push('ANONYME + salon privé : sub ACCEPTÉE (ready) — FUITE, le spike échoue');
  } catch (e) {
    verdicts.push(`ANONYME + salon privé : sub REFUSÉE (${e.message.slice(0, 60)})`);
  }
  try {
    await anonyme.souscrire('stream-room-messages', ridPublic, { useCollection: false, args: [] });
    verdicts.push('ANONYME + salon public : sub acceptée (ready)');
  } catch (e) {
    verdicts.push(`ANONYME + salon public : sub refusée (${e.message.slice(0, 60)})`);
  }

  // --- Connexion B : login DDP par resume token ----------------------------
  const connecte = new SpikeDDP('connecté');
  await connecte.connect();
  const loginResult = await connecte.appeler('login', { resume: auth.token });
  connecte.log('login DDP accepté, userId =', loginResult.id);
  verdicts.push('LOGIN DDP par {resume: <authToken REST>} : ACCEPTÉ — le même token sert aux deux');

  await connecte.souscrire('stream-room-messages', ridPrive, { useCollection: false, args: [] });
  connecte.log('sub stream-room-messages (privé) : ready');
  await connecte.souscrire('stream-notify-user', `${auth.userId}/subscriptions-changed`, {
    useCollection: false,
    args: [],
  });
  connecte.log('sub stream-notify-user subscriptions-changed : ready');

  // --- Le déclencheur : un message posté via REST --------------------------
  const marqueur = `spike-ddp ${new Date().toISOString()}`;
  await rest('POST', 'chat.postMessage', auth, { roomId: ridPrive, text: marqueur });
  console.log(`\nREST : message posté dans test-prive (« ${marqueur} »)\n`);

  // Deux secondes pour laisser les événements arriver.
  await new Promise((r) => setTimeout(r, 2000));

  const recu = connecte.evenements.some(
    (m) =>
      m.collection === 'stream-room-messages' &&
      m.fields?.args?.some?.((a) => a?.msg === marqueur),
  );
  verdicts.push(
    recu
      ? 'CONNECTÉ : le message REST est arrivé par stream-room-messages — temps réel prouvé'
      : 'CONNECTÉ : message NON reçu — chemin temps réel à diagnostiquer',
  );

  const recuAnonyme = anonyme.evenements.some((m) => m.collection === 'stream-room-messages');
  verdicts.push(
    recuAnonyme
      ? 'ANONYME : a reçu des événements — fuite à signaler'
      : 'ANONYME : aucun événement reçu',
  );

  anonyme.fermer();
  connecte.fermer();

  console.log('\n========== VERDICTS ==========');
  for (const v of verdicts) console.log(' •', v);

  const succes = recu && !recuAnonyme && !subAnonymePriveeAcceptee;
  console.log(succes ? '\nSPIKE : PASS' : '\nSPIKE : FAIL');
  process.exit(succes ? 0 : 1);
}

main().catch((e) => {
  console.error('échec du spike :', e.message);
  if (e.cause) console.error('cause :', e.cause);
  process.exit(1);
});
