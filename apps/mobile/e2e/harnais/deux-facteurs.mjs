// Active ou désactive le TOTP de bob, pour le flow 05.
//
//   node e2e/harnais/deux-facteurs.mjs enable   → imprime le SECRET base32
//   node e2e/harnais/deux-facteurs.mjs disable <SECRET>
//
// Les methods DDP `2fa:*` n'ont pas d'équivalent REST : ce harnais de TEST
// est le seul endroit du dépôt autorisé à faire du `method` DDP — il simule
// ce que l'app officielle de bob ferait, il ne fait pas partie du client.

import { totp } from './totp.mjs';

const BASE = process.env.ROOT_URL ?? 'http://localhost:3000';
const action = process.argv[2];
const secretFourni = process.argv[3];

// Rocket.Chat REFUSE la réutilisation d'un code déjà consommé (le flow vient
// d'en utiliser un), et n'accepte que ±1 fenêtre : selon l'alignement, une
// seule tentative peut tomber pile sur le code consommé. On essaie donc
// plusieurs fenêtres jusqu'à succès.
const FENETRES_MS = [30_000, 0, -30_000, 60_000];
async function essayerFenetres(secret, tenter) {
  let derniere;
  for (const decalage of FENETRES_MS) {
    try {
      return await tenter(totp(secret, Date.now() + decalage));
    } catch (e) {
      derniere = e;
      console.error(`  fenêtre ${decalage / 1000}s refusée : ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  throw derniere;
}

// Si la 2FA est DÉJÀ active (nettoyage après un run interrompu), le login
// simple répond totp-required : on rejoue avec le code calculé du secret.
async function loginBob() {
  const simple = await fetch(`${BASE}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026' }),
  });
  const corps = await simple.json();
  if (corps.data) return corps.data;
  // `/login` met le code d'erreur dans `error` (pas `errorType`).
  if ((corps.error === 'totp-required' || corps.errorType === 'totp-required') && secretFourni) {
    return essayerFenetres(secretFourni, async (code) => {
      const avecCode = await fetch(`${BASE}/api/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026', code }),
      });
      const c = await avecCode.json();
      if (!c.data) throw new Error(c.error ?? 'code refusé');
      return c.data;
    });
  }
  return undefined;
}

const bob = await loginBob();
if (!bob) {
  console.error('login bob impossible');
  process.exit(1);
}

const ws = new WebSocket(`${BASE.replace(/^http/i, 'ws')}/websocket`);
let id = 0;
const attentes = new Map();
const appeler = (method, ...params) =>
  new Promise((resoudre, rejeter) => {
    const mid = `m${++id}`;
    attentes.set(mid, { resoudre, rejeter });
    ws.send(JSON.stringify({ msg: 'method', method, id: mid, params }));
  });

ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.msg === 'ping') return ws.send(JSON.stringify({ msg: 'pong' }));
  if (m.msg === 'connected') {
    await appeler('login', { resume: bob.authToken });
    try {
      if (action === 'enable') {
        const { secret } = await appeler('2fa:enable');
        await appeler('2fa:validateTempToken', totp(secret));
        // `process.exit` n'attend pas les écritures asynchrones sur un tube :
        // le secret serait parfois TRONQUÉ dans `$(...)` — et perdu.
        await new Promise((r) => process.stdout.write(`${secret}\n`, () => r()));
      } else if (action === 'disable') {
        if (!secretFourni) throw new Error('disable exige le secret');
        await essayerFenetres(secretFourni, (code) => appeler('2fa:disable', code));
        console.log('ok');
      } else {
        throw new Error('usage: deux-facteurs.mjs enable | disable <SECRET>');
      }
      process.exit(0);
    } catch (err) {
      console.error(String(err?.message ?? err));
      process.exit(1);
    }
  }
  if (m.msg === 'result') {
    const attente = attentes.get(m.id);
    if (!attente) return;
    attentes.delete(m.id);
    if (m.error) attente.rejeter(new Error(m.error.message ?? 'méthode refusée'));
    else attente.resoudre(m.result);
  }
};
ws.onopen = () => ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
setTimeout(() => {
  console.error('délai dépassé');
  process.exit(1);
}, 20000);
