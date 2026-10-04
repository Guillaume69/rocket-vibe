// Vérité SERVEUR après un flow : les asserts Maestro peuvent être satisfaits
// par le rendu optimiste (02) ou par la légende encore dans le composer (04).
//
//   node e2e/harness/check-server.mjs <texte> [--fichier]

const BASE = process.env.ROOT_URL ?? 'http://localhost:3000';
const text = process.argv[2];
const requireFile = process.argv.includes('--fichier');
if (!text) {
  console.error('usage: check-server.mjs <texte> [--fichier]');
  process.exit(1);
}

const r = await fetch(`${BASE}/api/v1/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'alice', password: 'alice-dev-2026' }),
});
const alice = (await r.json()).data;

const channel = await fetch(`${BASE}/api/v1/channels.info?roomName=test-public`, {
  headers: { 'X-User-Id': alice.userId, 'X-Auth-Token': alice.authToken },
});
const rid = (await channel.json()).channel._id;

const h = await fetch(`${BASE}/api/v1/channels.history?roomId=${rid}&count=20`, {
  headers: { 'X-User-Id': alice.userId, 'X-Auth-Token': alice.authToken },
});
const messages = (await h.json()).messages ?? [];
const found = messages.find(
  (m) => m.msg === text && (!requireFile || typeof m.file?.name === 'string'),
);
if (!found) {
  console.error(`ABSENT DU SERVEUR : « ${text} »${requireFile ? ' (avec fichier)' : ''}`);
  process.exit(1);
}
console.log(`serveur ok : « ${text} »${requireFile ? ` + fichier ${found.file.name}` : ''}`);
