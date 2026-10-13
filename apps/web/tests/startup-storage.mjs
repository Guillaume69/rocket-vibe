import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

export async function startupStorage(browser, base) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  for (const [locale, heading, retry, username] of [
    ["en-US", "Unable to open Vibez", "Retry", "Username or email"],
    ["fr-FR", "Impossible d’ouvrir Vibez", "Réessayer", "Identifiant ou email"],
  ]) {
    const context = await browser.newContext({ locale });
    try {
      await context.route("**/__startup-storage-fixture", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Legacy storage fixture</title>",
        }),
      );
      const holder = await context.newPage();
      await holder.goto(base + "/__startup-storage-fixture");
      await holder.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("vibez-web", 5);
            request.onupgradeneeded = () => {
              for (const name of [
                "accounts",
                "cache",
                "outbox",
                "drafts",
                "operations",
                "uploads",
                "staged",
                "media",
                "reminders",
              ])
                request.result.createObjectStore(name);
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              window.testLegacy = request.result;
              const tx = request.result.transaction("drafts", "readwrite");
              tx.objectStore("drafts").put(
                "Saved before the upgrade",
                "startup-fixture:draft",
              );
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            };
          }),
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      const failure = page.getByRole("alert");
      await failure
        .getByRole("heading", { name: heading, exact: true })
        .waitFor();
      assert.match(
        await failure.innerText(),
        locale === "en-US"
          ? /Close other Vibez tabs or windows/
          : /Fermez les autres onglets ou fenêtres Vibez/,
      );
      await failure.getByRole("button", { name: retry, exact: true }).click();
      await failure
        .getByRole("heading", { name: heading, exact: true })
        .waitFor();
      await holder.evaluate(() => window.testLegacy.close());
      await failure.getByRole("button", { name: retry, exact: true }).click();
      await page.getByLabel(username, { exact: true }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      const result = await holder.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("vibez-web", 7);
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Current app did not release its database for upgrade",
                  ),
                ),
              5000,
            );
            request.onerror = () => {
              clearTimeout(timer);
              reject(request.error);
            };
            request.onsuccess = () => {
              clearTimeout(timer);
              const db = request.result,
                read = db
                  .transaction("drafts")
                  .objectStore("drafts")
                  .get("startup-fixture:draft");
              read.onerror = () => {
                db.close();
                reject(read.error);
              };
              read.onsuccess = () => {
                const value = { version: db.version, draft: read.result };
                db.close();
                resolve(value);
              };
            };
          }),
      );
      assert.deepEqual(result, {
        version: 7,
        draft: "Saved before the upgrade",
      });
      assert.deepEqual(errors, []);
      console.log(
        "PASS " +
          locale +
          " blocked startup retries preserve the draft and current tabs release future upgrades",
      );
    } finally {
      await context.close();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const browser = await chromium.launch({ headless: true });
  try {
    await startupStorage(
      browser,
      process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417",
    );
  } finally {
    await browser.close();
  }
}
