// bob posts a message in test-public; used DURING the outage of the
// reconnect flow.
//
//   node e2e/harness/post-as-bob.mjs "message text"

const BASE = process.env.ROOT_URL ?? 'http://localhost:3000';
const text = process.argv[2];
if (!text) {
  console.error('usage: post-as-bob.mjs <text>');
  process.exit(1);
}

const r = await fetch(`${BASE}/api/v1/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'bob', password: 'bob-dev-2026' }),
});
const body = await r.json();
const bob = body.data;
if (!bob) {
  console.error(
    `bob login failed (${body.errorType ?? body.error ?? '?'}): is his 2FA still active? ` +
      'Clean up with e2e/harness/two-factor.mjs disable <secret>, or users.resetTOTP as admin.',
  );
  process.exit(1);
}

const channels = await fetch(`${BASE}/api/v1/channels.info?roomName=test-public`, {
  headers: { 'X-User-Id': bob.userId, 'X-Auth-Token': bob.authToken },
});
const rid = (await channels.json()).channel._id;

const sendResponse = await fetch(`${BASE}/api/v1/chat.sendMessage`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-User-Id': bob.userId,
    'X-Auth-Token': bob.authToken,
  },
  body: JSON.stringify({ message: { rid, msg: text } }),
});
const response = await sendResponse.json();
if (!response.success) {
  console.error('send refused:', JSON.stringify(response).slice(0, 200));
  process.exit(1);
}
console.log('ok');
