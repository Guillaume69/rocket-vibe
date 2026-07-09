#!/usr/bin/env node
// Peuple le serveur Rocket.Chat de développement avec des données de test.
//
//   node scripts/seed.mjs
//
// Idempotent, y compris après un échec partiel : chaque message seedé porte un
// marqueur `[seed i/n]`, et seuls les marqueurs manquants sont reposés. Un
// script tué après 7 messages sur 12 reprend au huitième.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const NB_MESSAGES = 12;
const NB_REPONSES = 3;
const RACINE_FIL = '[seed fil] Racine du fil de discussion.';

const texteMessage = (i, label) =>
  `[seed ${i}/${NB_MESSAGES}] Message de test dans ${label}. **gras**, _italique_, \`code\`.`;
const texteReponse = (i) => `[seed fil ${i}/${NB_REPONSES}] Réponse dans le fil.`;

const RE_MESSAGE = /^\[seed (\d+)\/\d+\]/;
const RE_REPONSE = /^\[seed fil (\d+)\/\d+\]/;

/**
 * Lit un fichier `.env` sans dépendance externe.
 * Les guillemets encadrants sont retirés : `KEY="valeur"` est une forme
 * courante, et la conserver telle quelle produit une URL invalide.
 * Les commentaires en fin de ligne ne sont pas gérés — un `#` peut légitimement
 * figurer dans un mot de passe.
 */
function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${path} introuvable. Copie docker/.env.example en docker/.env.`);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = readEnvFile(join(ROOT, 'docker', '.env'));

// Le `.env` fait autorité : c'est de lui que viennent les identifiants. Un
// ROOT_URL exporté dans le shell et pointant ailleurs ferait tenter un login
// sur un serveur avec les identifiants d'un autre.
const BASE = (env.ROOT_URL || '').replace(/\/$/, '');
if (!BASE) throw new Error('ROOT_URL absent de docker/.env.');
if (process.env.ROOT_URL && process.env.ROOT_URL.replace(/\/$/, '') !== BASE) {
  process.stderr.write(
    `attention : $ROOT_URL (${process.env.ROOT_URL}) diffère de docker/.env (${BASE}).\n` +
      `           docker/.env fait foi, car il porte aussi les identifiants.\n`,
  );
}

const auth = { token: '', userId: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Appelle l'API REST. Rejoue sur 429 : `API_Enable_Rate_Limiter` est actif par
 * défaut et plafonne chaque endpoint. Le serveur indique la date de
 * réinitialisation dans `x-ratelimit-reset` (epoch ms) ; à défaut on retombe
 * sur un délai exponentiel.
 */
async function api(method, endpoint, body, attempt = 0) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) {
    headers['X-Auth-Token'] = auth.token;
    headers['X-User-Id'] = auth.userId;
  }

  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    // `Number(null)` vaut 0, donc un en-tête absent donne waitMs = 0 et bascule
    // sur le délai exponentiel — même chemin qu'un en-tête déjà expiré.
    const waitMs = Number.isFinite(reset) ? Math.max(reset - Date.now(), 0) : 0;
    const delay = waitMs > 0 ? waitMs + 250 : 1000 * 2 ** attempt;
    process.stderr.write(`  429 sur ${endpoint}, attente ${Math.round(delay)} ms\n`);
    await res.body?.cancel();
    await sleep(delay);
    return api(method, endpoint, body, attempt + 1);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} : réponse non JSON (${res.status}) ${text.slice(0, 120)}`);
  }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

async function must(method, endpoint, body) {
  const r = await api(method, endpoint, body);
  if (!r.ok) throw new Error(`${endpoint} a échoué (${r.status}) : ${JSON.stringify(r.json)}`);
  return r.json;
}

async function login() {
  const j = await must('POST', 'login', { user: env.ADMIN_USERNAME, password: env.ADMIN_PASS });
  auth.token = j.data.authToken;
  auth.userId = j.data.userId;
  console.log(`connecté comme ${env.ADMIN_USERNAME} (${j.data.me.roles.join(', ')})`);
}

async function ensureUser({ username, name, password }) {
  const found = await api('GET', `users.info?username=${encodeURIComponent(username)}`);
  if (found.ok) {
    console.log(`  utilisateur ${username} : existe déjà`);
    return found.json.user._id;
  }
  const j = await must('POST', 'users.create', {
    username,
    name,
    password,
    email: `${username}@rocket-vibe.test`,
    verified: true,
    requirePasswordChange: false,
    joinDefaultChannels: false,
    sendWelcomeEmail: false,
  });
  console.log(`  utilisateur ${username} : créé`);
  return j.user._id;
}

/** `kind` vaut "channels" (public) ou "groups" (privé). */
async function ensureRoom(kind, name, members) {
  const cle = kind === 'channels' ? 'channel' : 'group';
  const libelle = kind === 'channels' ? 'canal' : 'groupe';
  const found = await api('GET', `${kind}.info?roomName=${encodeURIComponent(name)}`);
  if (found.ok) {
    console.log(`  ${libelle} ${name} : existe déjà`);
    return found.json[cle]._id;
  }
  const j = await must('POST', `${kind}.create`, { name, members });
  console.log(`  ${libelle} ${name} : créé`);
  return j[cle]._id;
}

/** `im.create` est déjà idempotent côté serveur. */
async function ensureIm(username) {
  const j = await must('POST', 'im.create', { username });
  console.log(`  message direct avec ${username} : prêt`);
  return j.room._id;
}

async function historique(historyEndpoint, roomId) {
  const j = await must('GET', `${historyEndpoint}?roomId=${roomId}&count=100`);
  return j.messages || [];
}

/** Indices déjà présents parmi les messages portant le marqueur de seed. */
function indicesPresents(messages, regex) {
  const vus = new Set();
  for (const m of messages) {
    const found = regex.exec(m.msg || '');
    if (found) vus.add(Number(found[1]));
  }
  return vus;
}

/**
 * Reposte uniquement les messages manquants. Un salon partiellement seedé est
 * complété, jamais laissé en l'état ni dupliqué.
 */
async function seedMessages(historyEndpoint, roomId, label) {
  const messages = await historique(historyEndpoint, roomId);
  const presents = indicesPresents(
    messages.filter((m) => !m.tmid),
    RE_MESSAGE,
  );
  const manquants = [];
  for (let i = 1; i <= NB_MESSAGES; i++) if (!presents.has(i)) manquants.push(i);

  if (manquants.length === 0) {
    console.log(`  messages de ${label} : ${NB_MESSAGES}/${NB_MESSAGES}, rien à faire`);
    return;
  }
  for (const i of manquants) {
    await must('POST', 'chat.postMessage', { roomId, text: texteMessage(i, label) });
  }
  console.log(`  messages de ${label} : ${manquants.length} posté(s), total ${NB_MESSAGES}`);
}

/**
 * Le fil est vérifié indépendamment des messages du salon. Le coupler à « on
 * vient de poster les messages » le rendrait impossible à créer sur un salon
 * qui en contient déjà.
 */
async function seedThread(historyEndpoint, roomId) {
  const messages = await historique(historyEndpoint, roomId);
  let racine = messages.find((m) => m.msg === RACINE_FIL && !m.tmid);
  if (!racine) {
    const j = await must('POST', 'chat.postMessage', { roomId, text: RACINE_FIL });
    racine = j.message;
    console.log('  fil : racine créée');
  }

  const fil = await must('GET', `chat.getThreadMessages?tmid=${racine._id}&count=50`);
  const presents = indicesPresents(fil.messages || [], RE_REPONSE);
  const manquants = [];
  for (let i = 1; i <= NB_REPONSES; i++) if (!presents.has(i)) manquants.push(i);

  if (manquants.length === 0) {
    console.log(`  fil : ${NB_REPONSES}/${NB_REPONSES} réponses, rien à faire`);
    return;
  }
  for (const i of manquants) {
    await must('POST', 'chat.sendMessage', {
      message: { rid: roomId, tmid: racine._id, msg: texteReponse(i) },
    });
  }
  console.log(`  fil : ${manquants.length} réponse(s) postée(s), total ${NB_REPONSES}`);
}

async function main() {
  console.log(`serveur : ${BASE}`);
  await login();

  console.log('utilisateurs');
  await ensureUser({ username: 'alice', name: 'Alice Martin', password: 'alice-dev-2026' });
  await ensureUser({ username: 'bob', name: 'Bob Durand', password: 'bob-dev-2026' });

  console.log('salons');
  const publicId = await ensureRoom('channels', 'test-public', ['alice', 'bob']);
  const priveId = await ensureRoom('groups', 'test-prive', ['alice']);
  const dmId = await ensureIm('alice');

  console.log('messages');
  await seedMessages('channels.history', publicId, 'test-public');
  await seedMessages('groups.history', priveId, 'test-prive');
  await seedMessages('im.history', dmId, 'le direct avec alice');
  await seedThread('channels.history', publicId);

  console.log('\nterminé.');
}

main().catch((e) => {
  // `fetch` masque la vraie cause (ECONNREFUSED, DNS…) dans `e.cause`.
  process.stderr.write(`\néchec du seed : ${e.message}\n`);
  if (e.cause) process.stderr.write(`cause : ${e.cause}\n`);
  process.exit(1);
});
