import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(base).hostname),
  "Use the isolated local test server",
);
const aliceName = process.env.RV_WEB_ALICE || "webalice";
const bobName = process.env.RV_WEB_BOB || "webbob";
const password = "web-client-disposable-password";
const call = async (
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  assert.ok(
    response.ok,
    method + " " + path + " " + response.status + " " + JSON.stringify(value),
  );
  return value;
};
const alice = await call("/api/v1/auth/login", null, {
  username: aliceName,
  password,
});
const bob = await call("/api/v1/auth/login", null, {
  username: bobName,
  password,
});
const tag = "web-" + crypto.randomUUID().slice(0, 8);
const room = await call("/api/v1/rooms", alice.token, {
  name: tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
const other = await call("/api/v1/rooms", alice.token, {
  name: tag + "-other",
  private: false,
  operation_id: crypto.randomUUID(),
});
await call(
  "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
  alice.token,
  null,
);
const initial = await call(
  "/api/v1/rooms/" + room.id + "/messages",
  bob.token,
  {
    operation_id: crypto.randomUUID(),
    text: "**Hello from GTK**\nThe same conversation, now in the browser.\n<script>window.evil = true</script>",
  },
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RV_BROWSER_PATH
    ? { executablePath: process.env.RV_BROWSER_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
await context.addInitScript(() => localStorage.setItem("rv-language", "en"));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let checks = 0;
const pass = (name) => {
  checks++;
  console.log("PASS " + name);
};
const visible = async (locator) => {
  await locator.waitFor({ state: "visible", timeout: 20000 });
};
try {
  await page.goto(base);
  await page.evaluate(() => document.fonts.ready);
  await visible(page.getByLabel("Username or email"));
  assert.equal(await page.getByLabel("Server", { exact: true }).count(), 0);
  assert.equal(
    await page.locator(".login-origin").textContent(),
    new URL(base).host,
  );
  await page.getByLabel("Username or email").fill(aliceName);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await visible(page.locator(".login-error:not(:empty)"));
  pass("invalid login stays on login");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await visible(page.locator(".shell"));
  assert.equal(await page.locator(".server-rail").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Add an account" }).count(),
    0,
  );
  pass("single service and single account");
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await visible(page.locator('[data-id="' + initial.id + '"]'));
  assert.equal(await page.evaluate(() => window.evil), undefined);
  pass("real history and safe markdown");
  await page.waitForFunction(
    () =>
      document.fonts.check("14px Nunito") &&
      document.fonts.check('800 23px "Baloo 2"'),
  );
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--window-bg-color")
        .trim()
        .toUpperCase(),
    ),
    "#0C0B16",
  );
  pass("GTK palette and bundled fonts");
  await mkdir("../../.cache/web-shots", { recursive: true });
  await page.screenshot({ path: "../../.cache/web-shots/chat.png" });
  const composer = page.locator(".room-content .rich-composer");
  await composer.fill("Sent in browser " + tag);
  await composer.press("Enter");
  await visible(
    page
      .locator(".timeline .message-body")
      .filter({ hasText: "Sent in browser " + tag }),
  );
  let history = await call(
    "/api/v1/rooms/" + room.id + "/messages",
    alice.token,
  );
  const sent = history.messages.find(
    (message) => message.text === "Sent in browser " + tag,
  );
  assert.ok(sent);
  assert.equal(
    history.messages.filter((message) => message.text === sent.text).length,
    1,
  );
  pass("idempotent ordinary send");
  await page.locator('[data-id="' + sent.id + '"] .row-more').click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-field textarea").fill("Edited in browser " + tag);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await visible(
    page
      .locator(".message-body")
      .filter({ hasText: "Edited in browser " + tag }),
  );
  pass("edit through server permissions");
  await page.locator('[data-id="' + initial.id + '"] .row-more').click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await visible(page.locator('[data-id="' + initial.id + '"] .reaction'));
  pass("live reactions");
  await page.locator('[data-id="' + initial.id + '"] .row-more').click();
  await page
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await visible(page.locator(".thread-pane"));
  await page.locator(".thread-pane .rich-composer").fill("Thread reply " + tag);
  await page.locator(".thread-pane .rich-composer").press("Enter");
  await visible(
    page
      .locator(".thread-pane article .message-body")
      .filter({ hasText: "Thread reply " + tag }),
  );
  await page
    .locator(".thread-pane")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  pass("thread roots and replies");
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Attach a file", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "web-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A real protected upload " + tag),
  });
  await visible(page.locator(".staged-chip"));
  await composer.fill("File caption " + tag);
  await composer.press("Enter");
  await visible(
    page.locator(".file-title").filter({ hasText: "web-proof.txt" }),
  );
  history = await call("/api/v1/rooms/" + room.id + "/messages", alice.token);
  const attachment = history.messages.find((message) =>
    message.files?.some((file) => file.filename === "web-proof.txt"),
  );
  assert.ok(attachment);
  assert.equal(attachment.text, "File caption " + tag);
  pass("staged attachment, caption and native upload confirmation");
  await page
    .locator(".room-header")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await page.locator('dialog input[type="search"]').fill("Edited in browser");
  await visible(
    page
      .locator("dialog .message-body")
      .filter({ hasText: "Edited in browser " + tag }),
  );
  await page.locator("dialog .dialog-header button").click();
  pass("room search");
  await composer.fill("Persisted draft " + tag);
  await page
    .locator('[data-room="' + other.id + '"]')
    .first()
    .click();
  await page.waitForFunction((id) => location.pathname.endsWith(id), other.id);
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.waitForFunction(
    (text) =>
      document.querySelector(".room-content .rich-composer")?.value === text,
    "Persisted draft " + tag,
  );
  await composer.fill("");
  pass("per-room drafts");
  await page.reload();
  await visible(page.locator(".shell"));
  await visible(page.locator('[data-id="' + initial.id + '"]'));
  pass("resumed session and cached room navigation");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await composer.fill("Offline durable " + tag);
  await composer.press("Enter");
  await visible(page.locator(".pending-row"));
  await page.reload();
  await visible(page.locator(".shell"));
  await visible(page.locator(".pending-row"));
  pass("offline reload retains durable outbox");
  await context.setOffline(false);
  await visible(
    page.locator(".message-body").filter({ hasText: "Offline durable " + tag }),
  );
  await page.waitForFunction(() => !document.querySelector(".pending-row"));
  history = await call("/api/v1/rooms/" + room.id + "/messages", alice.token);
  assert.equal(
    history.messages.filter(
      (message) => message.text === "Offline durable " + tag,
    ).length,
    1,
  );
  pass("reconnect sends the durable operation once");
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click({ button: "right" });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".section-header")).some((node) =>
      node.textContent?.includes("Favourites"),
    ),
  );
  pass("room favourites and independent read state");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await visible(page.locator(".sidebar-dialog"));
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await visible(page.locator(".preferences-page select"));
  await page.screenshot({ path: "../../.cache/web-shots/settings.png" });
  await page.locator(".sidebar-dialog .preferences-close").click();
  pass("GTK category preferences dialog");
  await page.setViewportSize({ width: 540, height: 800 });
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.screenshot({ path: "../../.cache/web-shots/narrow.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  pass("narrow screen navigation");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await visible(page.getByLabel("Username or email"));
  assert.equal(await page.getByLabel("Server", { exact: true }).count(), 0);
  assert.equal(
    await page.locator(".login-origin").textContent(),
    new URL(base).host,
  );
  const accounts = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("rocket-vibe-web");
        request.onsuccess = () => {
          const get = request.result
            .transaction("accounts")
            .objectStore("accounts")
            .getAll();
          get.onsuccess = () => resolve(get.result.length);
          get.onerror = () => reject(get.error);
        };
      }),
  );
  assert.equal(accounts, 0);
  pass("logout purges the sole local session");
  assert.deepEqual(errors, []);
  console.log(checks + " real-server browser scenarios passed");
} catch (error) {
  await mkdir("../../.cache/web-shots", { recursive: true });
  await page.screenshot({ path: "../../.cache/web-shots/failure.png" });
  console.log("UI errors:", await page.locator(".toast").allTextContents());
  throw error;
} finally {
  await browser.close();
}
