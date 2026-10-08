import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function saved(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("rocket-vibe-web");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise((resolve, reject) => {
      const req = db
        .transaction("accounts")
        .objectStore("accounts")
        .get(localStorage.getItem("rv-active"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}
async function due(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open("rocket-vibe-web");
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("accounts", "readwrite"),
        store = tx.objectStore("accounts"),
        key = localStorage.getItem("rv-active"),
        req = store.get(key);
      req.onsuccess = () => {
        const value = req.result;
        value.session.expires_at = new Date(Date.now() + 1000).toISOString();
        store.put(value, key);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
}
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill("webalice");
  await page
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".shell").waitFor();
  await page.locator(".status-dot.online").waitFor();
  const before = await saved(page);
  await due(page);
  let lostIntent;
  let committed = false;
  await page.route("**/api/v1/auth/renew", async (route) => {
    if (!committed) {
      lostIntent = route.request().postDataJSON();
      const response = await route.fetch();
      assert.ok(response.ok());
      committed = true;
    }
    await route.abort("connectionreset");
  });
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector(".status-dot")?.classList.contains("offline"),
  );
  assert.ok(committed);
  assert.equal((await saved(page)).session.token, before.session.token);
  console.log(
    "PASS accepted rotation with lost response retains the previous token and durable intent",
  );
  await page.unroute("**/api/v1/auth/renew");
  let replay;
  page.on("request", (request) => {
    if (request.url().endsWith("/auth/renew")) replay = request.postDataJSON();
  });
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  const recovered = await saved(page);
  assert.notEqual(recovered.session.token, before.session.token);
  assert.equal(recovered.session.token, lostIntent.next_token);
  assert.equal(replay, undefined);
  console.log(
    "PASS reload probes the durable successor and recovers the accepted session without a second rotation",
  );
  const other = await context.newPage();
  await other.goto(base);
  await other.locator(".shell").waitFor();
  await other.locator(".status-dot.online").waitFor();
  await due(page);
  let renewals = 0;
  await context.route("**/api/v1/auth/renew", async (route) => {
    renewals++;
    await route.continue();
  });
  await Promise.all([page.reload(), other.reload()]);
  await page.locator(".status-dot.online").waitFor();
  await other.locator(".status-dot.online").waitFor();
  assert.equal(renewals, 1);
  assert.equal(
    (await saved(page)).session.token,
    (await saved(other)).session.token,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS two tabs serialize session rotation without duplicate successor operations",
  );
} finally {
  await browser.close();
}
