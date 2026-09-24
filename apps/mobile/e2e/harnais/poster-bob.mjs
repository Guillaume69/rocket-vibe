// bob poste un message dans test-public — utilisé PENDANT la coupure du
// flow reconnexion.
//
//   node e2e/harnais/poster-bob.mjs "texte du message"

const BASE = process.env.ROOT_URL ?? 'http://localhost:3000';
const texte = process.argv[2];
if (!texte) {
  console.error('usage: poster-bob.mjs <texte>');
  process.exit(1);
}

const r = await fetch(`${BASE}/api/v1/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026' }),
});
const corps = await r.json();
const bob = corps.data;
if (!bob) {
  console.error(
    `login bob impossible (${corps.errorType ?? corps.error ?? '?'}) — sa 2FA est-elle restée active ? ` +
      'Nettoie avec e2e/harnais/deux-facteurs.mjs disable <secret>, ou users.resetTOTP côté admin.',
  );
  process.exit(1);
}

const canaux = await fetch(`${BASE}/api/v1/channels.info?roomName=test-public`, {
  headers: { 'X-User-Id': bob.userId, 'X-Auth-Token': bob.authToken },
});
const rid = (await canaux.json()).channel._id;

const envoi = await fetch(`${BASE}/api/v1/chat.sendMessage`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-User-Id': bob.userId,
    'X-Auth-Token': bob.authToken,
  },
  body: JSON.stringify({ message: { rid, msg: texte } }),
});
const reponse = await envoi.json();
if (!reponse.success) {
  console.error('envoi refusé:', JSON.stringify(reponse).slice(0, 200));
  process.exit(1);
}
console.log('ok');
