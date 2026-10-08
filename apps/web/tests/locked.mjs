import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US" }),
  page = await context.newPage();
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill("webalice");
  await page
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  const room = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open("rocket-vibe-web");
      req.onsuccess = () => resolve(req.result);
    });
    const cache = await new Promise((resolve) => {
      const req = db
        .transaction("cache")
        .objectStore("cache")
        .get(localStorage.getItem("rv-active"));
      req.onsuccess = () => resolve(req.result);
    });
    return cache.rooms.find(
      (room) => room.kind !== "direct" && !room.voice && !room.encrypted,
    ).id;
  });
  await page
    .locator('[data-room="' + room + '"]')
    .first()
    .click();
  await page.locator(".timeline article").first().waitFor();
  await context.setOffline(true);
  // Synthetic cached metadata exercises the client's exclusion without creating a
  // fake server-side MLS group. It is deliberately not a crypto protocol test.
  await page.evaluate(async (room) => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open("rocket-vibe-web");
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("cache", "readwrite"),
        store = tx.objectStore("cache"),
        key = localStorage.getItem("rv-active"),
        req = store.get(key);
      req.onsuccess = () => {
        const cache = req.result;
        cache.rooms.find((value) => value.id === room).encrypted = true;
        store.put(cache, key);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, room);
  await page.reload();
  await page.locator(".e2e-banner").waitFor();
  assert.equal(await page.locator(".timeline article").count(), 0);
  assert.equal(
    await page.locator(".room-content .composer").isVisible(),
    false,
  );
  assert.equal(
    await page
      .locator(".room-header")
      .getByRole("button", { name: "Join call", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.locator(".room-content .rich-composer").isDisabled(),
    true,
  );
  console.log(
    "PASS unsupported encrypted metadata hides history, composer, attachments, recording and calls after reload",
  );
} finally {
  await browser.close();
}
