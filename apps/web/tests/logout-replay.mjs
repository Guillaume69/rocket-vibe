// A sign-out the server never heard (its request blocked): the browser forgets
// the account at once, keeps only the session's token in its own store, and
// replays the sign-out when back online or at the next start, after which the
// token is refused by the server and forgotten. Then Settings > App >
// Diagnostics downloads a log of recent events with no token or name in it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_LOGOUT_USER || "weblogoutreplay";
const password = "web-client-disposable-password";
const status = async (token) =>
  (
    await fetch(base + "/api/v1/me", {
      headers: { Authorization: "Bearer " + token },
    })
  ).status;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
});
const page = await context.newPage();
const stores = (name) =>
  page.evaluate(
    (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("rocket-vibe-web");
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(name)) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
        request.onerror = () => reject(request.error);
      }),
    name,
  );
const signIn = async () => {
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  const [account] = await stores("accounts");
  assert.ok(account?.session?.token);
  assert.equal(await status(account.session.token), 200);
  return account.session.token;
};
const signOut = async () => {
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
};
const until = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await page.waitForTimeout(100);
  }
  assert.fail("timed out: " + what);
};
const blocked = (route) => route.abort("internetdisconnected");
const tokens = [];
try {
  await page.goto(base);
  // Replay when the browser is back online.
  const first = await signIn();
  tokens.push(first);
  await page.route("**/api/v1/auth/logout", blocked);
  await signOut();
  await page
    .getByText("Signed out of this browser.", { exact: false })
    .waitFor();
  await page.getByLabel("Username or email").waitFor();
  assert.equal((await stores("accounts")).length, 0);
  let pending = await stores("logouts");
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].tokens, [first]);
  assert.deepEqual(Object.keys(pending[0]).sort(), ["expires", "id", "tokens"]);
  assert.ok(!(await page.content()).includes(first), "never in the page");
  assert.equal(await status(first), 200, "the server never heard it");
  console.log(
    "PASS an unreached sign-out forgets the account, keeps its token",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1000);
  assert.equal((await stores("logouts")).length, 1, "still unreachable");
  assert.equal(await status(first), 200);
  await page.unroute("**/api/v1/auth/logout", blocked);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await until(async () => (await status(first)) === 401, "replay online");
  await until(
    async () => (await stores("logouts")).length === 0,
    "entry forgotten",
  );
  console.log("PASS back online, the sign-out is replayed and forgotten");
  // Replay at the next start.
  const second = await signIn();
  tokens.push(second);
  await page.route("**/api/v1/auth/logout", blocked);
  await signOut();
  await page.getByLabel("Username or email").waitFor();
  pending = await stores("logouts");
  assert.deepEqual(
    pending.map((entry) => entry.tokens),
    [[second]],
  );
  assert.equal(await status(second), 200);
  await page.unroute("**/api/v1/auth/logout", blocked);
  await page.reload();
  await until(async () => (await status(second)) === 401, "replay at start");
  await until(
    async () => (await stores("logouts")).length === 0,
    "entry forgotten at start",
  );
  console.log("PASS at the next start, the sign-out is replayed and forgotten");
  // Diagnostics: the events, never a token or a name.
  const third = await signIn();
  tokens.push(third);
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "App", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.locator(".action-row", { hasText: "Diagnostics" }).click();
  const file = await download;
  assert.match(
    file.suggestedFilename(),
    /^rocketvibe-web-diagnostics-.*\.txt$/,
  );
  const text = await readFile(await file.path(), "utf8");
  assert.match(text, /^RocketVibe web \d+\.\d+\.\d+/);
  assert.match(text, /User agent: /);
  assert.match(text, /connection online/);
  // The page was reloaded since the first sign-out: its start replayed one.
  assert.match(text, /sign-out replay: 1 finished, 0 pending/);
  for (const secret of [...tokens, username, password])
    assert.ok(!text.includes(secret), "no token or name in the log");
  console.log("PASS Diagnostics downloads recent events, no token or name");
  await page.keyboard.press("Escape");
  await signOut();
  await page.getByLabel("Username or email").waitFor();
  await until(async () => (await status(third)) === 401, "plain sign-out");
} finally {
  await browser.close();
}
