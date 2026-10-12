import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417",
  names = [
    process.env.RV_WEB_PENDING_USER || "websecpendinggtk",
    process.env.RV_WEB_PENDING_EMAIL_USER || "websecpendingemailgtk",
  ],
  pg = process.env.RV_WEB_PENDING_PG_CONTAINER || "rv-web-gtk-parity-db",
  password = "web-client-disposable-password";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
assert.ok(names.every((name) => /^websec[a-z0-9]+$/.test(name)));
assert.ok(/^[a-zA-Z0-9_.-]+$/.test(pg));
const expire = (name) =>
  execFileSync(
    "docker",
    [
      "exec",
      pg,
      "psql",
      "-U",
      "web",
      "-d",
      "web",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "BEGIN; UPDATE session_devices SET created_at=clock_timestamp()-interval '1 hour' WHERE user_id=(SELECT id FROM users WHERE username='" +
        name +
        "'); UPDATE reauthentication_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE username='" +
        name +
        "'); COMMIT;",
    ],
    { stdio: "pipe" },
  );
const totp = (secret) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    bits = [...secret]
      .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
      .join(""),
    bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest(),
    offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
};
const browser = await chromium.launch({ headless: true }),
  contexts = [],
  pages = [],
  pageerrors = [];
const open = async (page) => {
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await page.locator(".security-account-status").waitFor();
};
const reload = async (page) => {
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await open(page);
};
const click = async (page, name) =>
  page
    .locator(".preferences-page")
    .getByRole("button", { name, exact: true })
    .click();
const confirm = async (page, name) => {
  await click(page, name);
  await page
    .locator(".alert-dialog")
    .getByRole("button", { name, exact: true })
    .click();
};
const codes = async (page) => {
  await page.locator(".backup-codes").waitFor();
  return (await page.locator(".backup-codes").textContent()).trim().split("\n");
};
const acknowledge = async (page) => click(page, "I have saved my codes");
const api = async (page, path) =>
  page.evaluate(async (path) => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("rocket-vibe-web", 6);
      request.onsuccess = () => resolve(request.result);
    });
    const accounts = await new Promise((resolve) => {
      const request = db
        .transaction("accounts")
        .objectStore("accounts")
        .getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    const response = await fetch(path, {
      headers: { Authorization: "Bearer " + accounts[0].session.token },
    });
    if (!response.ok) throw Error("Fixture read " + response.status);
    return response.json();
  }, path);
const sealed = async (page, forbidden = []) => {
  const snapshot = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("rocket-vibe-web", 6);
      request.onsuccess = () => resolve(request.result);
    });
    const result = { text: "", sealed: [] };
    for (const name of ["operations", "cache", "outbox"]) {
      const entries = await new Promise((resolve) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
      });
      result.text += JSON.stringify(entries);
      if (name === "operations")
        result.sealed = entries
          .filter((value) => value?.ciphertext instanceof ArrayBuffer)
          .map((value) => ({
            extractable: value.key.extractable,
            bytes: value.ciphertext.byteLength,
          }));
    }
    db.close();
    return result;
  });
  for (const secret of forbidden)
    assert.ok(
      !snapshot.text.includes(secret),
      "ordinary stores must not contain sensitive cleartext",
    );
  assert.ok(
    snapshot.sealed.every((value) => !value.extractable && value.bytes > 0),
  );
  return snapshot.sealed.length;
};
const lost = async (page, path, action) => {
  let resolve;
  const committed = new Promise((done) => (resolve = done));
  await page.route(
    "**" + path,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const value = await response.json();
      await route.abort("failed");
      resolve(value);
    },
    { times: 1 },
  );
  await action();
  let timer;
  try {
    return await Promise.race([
      committed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Expected committed fixture response was not received: " + path,
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const prove = async (page, backup) => {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  if (backup) {
    await page.getByLabel("Confirmation method").selectOption("recovery_code");
    await page.getByLabel("Backup code", { exact: true }).waitFor();
    await page
      .locator('input[autocomplete="one-time-code"]')
      .first()
      .fill(backup);
    await page
      .getByRole("button", { name: "Confirm my identity", exact: true })
      .click();
  }
};
const pending = async (page, title) => {
  const row = page.locator(".security-pending");
  await row.getByRole("heading", { name: title, exact: true }).waitFor();
  await row.getByRole("button", { name: "Continue", exact: true }).waitFor();
  await page.locator(".security-account-status").waitFor();
  return row;
};
const requestIDs = [];
const proofStarts = () =>
  requestIDs.filter((item) => item.path === "/api/v1/me/reauth/start").length;
try {
  for (const username of names) {
    const context = await browser.newContext({ locale: "en-US" }),
      page = await context.newPage();
    contexts.push(context);
    pages.push(page);
    page.on("pageerror", (error) => pageerrors.push(error.message));
    page.on("response", async (response) => {
      if (response.status() >= 400 && /\/me\/reauth\//.test(response.url())) {
        const value = await response.json().catch(() => ({}));
        console.log(
          "Fixture proof refusal",
          new URL(response.url()).pathname,
          response.status(),
          value.code || "invalid_response",
        );
      }
    });
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/me\/(factors|reauth)/.test(request.url())
      ) {
        const input = request.postDataJSON();
        requestIDs.push({
          page: username,
          path: new URL(request.url()).pathname,
          id: input.operation_id,
          version: input.factor_version,
        });
      }
    });
    await page.goto(base);
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".status-dot.online").waitFor();
    await open(page);
  }
  const [factorPage, emailPage] = pages;
  await click(factorPage, "Set up an authenticator app");
  await factorPage.locator(".totp-secret").waitFor();
  const secret = await factorPage.locator(".totp-secret").textContent();
  assert.equal(await sealed(factorPage, [secret]), 1);
  await factorPage
    .getByLabel("Authenticator app code", { exact: true })
    .fill(totp(secret));
  const enabled = await lost(factorPage, "/api/v1/me/factors/totp/enable", () =>
    click(factorPage, "Enable two-factor authentication"),
  );
  expire(names[0]);
  await reload(factorPage);
  assert.deepEqual(await codes(factorPage), enabled.codes);
  await sealed(factorPage, [secret, ...enabled.codes]);
  assert.equal(
    requestIDs.filter(
      (item) =>
        item.page === names[0] && item.path === "/api/v1/me/reauth/start",
    ).length,
    0,
  );
  const enables = requestIDs.filter((item) =>
    item.path.endsWith("/totp/enable"),
  );
  assert.ok(
    enables.length >= 2 && enables.every((item) => item.id === enables[0].id),
  );
  await acknowledge(factorPage);
  console.log(
    "PASS committed authenticator enable recovers the exact sealed code bag after lost answer, proof expiry and reload",
  );
  await confirm(factorPage, "Replace backup codes");
  let row = await pending(factorPage, "Replace backup codes");
  await factorPage.screenshot({
    path: "../../.cache/web-shots/web-security-pending-reference.png",
    mask: [
      factorPage.locator(
        "input[type=password],input[autocomplete=one-time-code]",
      ),
    ],
  });
  const initial = (await api(factorPage, "/api/v1/me/factors")).factor_version;
  await reload(factorPage);
  row = await pending(factorPage, "Replace backup codes");
  const pendingIDs = requestIDs.filter((item) =>
    item.path.endsWith("/recovery/regenerate"),
  );
  assert.ok(pendingIDs.every((item) => item.id === pendingIDs[0].id));
  const beforeCancelProof = proofStarts();
  await row
    .getByRole("button", { name: "Cancel this change", exact: true })
    .click();
  await row.waitFor({ state: "hidden" });
  assert.equal(proofStarts(), beforeCancelProof);
  assert.equal(
    (await api(factorPage, "/api/v1/me/factors")).factor_version,
    initial,
  );
  assert.equal(await sealed(factorPage), 0);
  console.log(
    "PASS unfinished regeneration retains status and nonce; Cancel does not prove identity or change factors",
  );
  await confirm(factorPage, "Replace backup codes");
  row = await pending(factorPage, "Replace backup codes");
  await row.getByRole("button", { name: "Continue", exact: true }).click();
  const regenerated = await lost(
    factorPage,
    "/api/v1/me/factors/recovery/regenerate",
    () => prove(factorPage, enabled.codes[0]),
  );
  expire(names[0]);
  await reload(factorPage);
  assert.deepEqual(await codes(factorPage), regenerated.codes);
  await acknowledge(factorPage);
  await confirm(factorPage, "Disable authenticator app");
  row = await pending(factorPage, "Disable authenticator app");
  await row
    .getByRole("button", { name: "Cancel this change", exact: true })
    .click();
  assert.equal((await api(factorPage, "/api/v1/me/factors")).totp, true);
  console.log(
    "PASS Continue proves identity then replays the original regeneration; committed replay and cancelled disable preserve factor state",
  );
  expire(names[1]);
  await reload(emailPage);
  await click(emailPage, "Set up an authenticator app");
  row = await pending(emailPage, "Set up an authenticator app");
  await row
    .getByRole("button", { name: "Cancel this change", exact: true })
    .click();
  assert.equal((await api(emailPage, "/api/v1/me/factors")).totp, false);
  const mails = JSON.parse(
      await readFile("../../.cache/smtp-mails.json", "utf8"),
    ),
    since = mails.length;
  await emailPage
    .getByLabel("New email address", { exact: true })
    .fill(names[1] + "@example.test");
  await click(emailPage, "Send a verification code");
  await emailPage
    .getByText(
      "The code has not been sent yet. Confirm your identity to continue.",
      {
        exact: false,
      },
    )
    .waitFor();
  await emailPage.screenshot({
    path: "../../.cache/web-shots/web-security-email-pending-reference.png",
    mask: [
      emailPage.locator(
        "input[type=password],input[autocomplete=one-time-code]",
      ),
    ],
  });
  const beforeEmailCancel = proofStarts();
  await click(emailPage, "Cancel this verification");
  await emailPage.getByLabel("New email address", { exact: true }).waitFor();
  assert.equal(proofStarts(), beforeEmailCancel);
  assert.equal((await api(emailPage, "/api/v1/me/email")).address, null);
  assert.equal(await sealed(emailPage), 0);
  await emailPage
    .getByLabel("New email address", { exact: true })
    .fill(names[1] + "@example.test");
  await click(emailPage, "Send a verification code");
  await emailPage
    .getByText(
      "The code has not been sent yet. Confirm your identity to continue.",
      { exact: false },
    )
    .waitFor();
  await emailPage
    .locator(".preferences-page")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await prove(emailPage);
  await emailPage
    .getByLabel("Email code (8 digits)", { exact: true })
    .waitFor();
  let mailCode;
  for (let attempt = 0; attempt < 100 && !mailCode; attempt++) {
    const messages = JSON.parse(
      await readFile("../../.cache/smtp-mails.json", "utf8"),
    );
    const message = messages
      .slice(since)
      .find((message) => message.includes(names[1] + "@example.test"));
    if (message) {
      const decoded = message
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
      mailCode = /\b([0-9]{8})\b/.exec(decoded)?.[1];
    }
    if (!mailCode) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(mailCode);
  await emailPage
    .getByLabel("Email code (8 digits)", { exact: true })
    .fill(mailCode);
  await lost(emailPage, "/api/v1/me/email/verification/confirm", () =>
    click(emailPage, "Verify this address"),
  );
  expire(names[1]);
  await reload(emailPage);
  await emailPage
    .getByText("The address has been verified.", { exact: true })
    .waitFor();
  await click(emailPage, "Done");
  console.log(
    "PASS pending email verification Continue and committed lost confirmation recover Verified/Done after expired proof",
  );
  await confirm(emailPage, "Enable email codes");
  row = await pending(emailPage, "Enable email codes");
  await row.getByRole("button", { name: "Continue", exact: true }).click();
  const emailEnabled = await lost(
    emailPage,
    "/api/v1/me/factors/email/enable",
    () => prove(emailPage),
  );
  expire(names[1]);
  await reload(emailPage);
  assert.deepEqual(await codes(emailPage), emailEnabled.codes);
  await acknowledge(emailPage);
  assert.equal((await api(emailPage, "/api/v1/me/factors")).email, true);
  await confirm(emailPage, "Disable email codes");
  row = await pending(emailPage, "Disable email codes");
  await row
    .getByRole("button", { name: "Cancel this change", exact: true })
    .click();
  assert.equal((await api(emailPage, "/api/v1/me/factors")).email, true);
  await confirm(emailPage, "Disable email codes");
  row = await pending(emailPage, "Disable email codes");
  await row.getByRole("button", { name: "Continue", exact: true }).click();
  await lost(emailPage, "/api/v1/me/factors/email/disable", () =>
    prove(emailPage, emailEnabled.codes[0]),
  );
  expire(names[1]);
  await reload(emailPage);
  await emailPage
    .getByRole("button", { name: "Enable email codes", exact: true })
    .waitFor();
  assert.equal((await api(emailPage, "/api/v1/me/factors")).email, false);
  await sealed(emailPage, emailEnabled.codes);
  console.log(
    "PASS email enable and disable preserve their original direction through proof expiry, cancellation and accepted lost answers",
  );
  await confirm(emailPage, "Remove this email address");
  await emailPage
    .getByText(
      "Removal is not confirmed yet. Continue to resume it or cancel this request.",
      {
        exact: false,
      },
    )
    .waitFor();
  const beforeRemovalCancel = proofStarts(),
    contact = await api(emailPage, "/api/v1/me/email");
  await click(emailPage, "Cancel this removal request");
  await emailPage
    .getByRole("button", { name: "Remove this email address", exact: true })
    .waitFor();
  assert.equal(proofStarts(), beforeRemovalCancel);
  assert.equal(
    (await api(emailPage, "/api/v1/me/email")).address,
    contact.address,
  );
  assert.equal(await sealed(emailPage), 0);
  await confirm(emailPage, "Remove this email address");
  await emailPage
    .getByText(
      "Removal is not confirmed yet. Continue to resume it or cancel this request.",
      { exact: false },
    )
    .waitFor();
  await emailPage
    .locator(".preferences-page")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await lost(emailPage, "/api/v1/me/email/removal/start", () =>
    prove(emailPage),
  );
  expire(names[1]);
  await reload(emailPage);
  await emailPage
    .getByText("The email address has been removed.", { exact: true })
    .waitFor();
  await click(emailPage, "Done");
  await emailPage
    .getByRole("button", { name: "Done", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await sealed(emailPage), 0);
  console.log(
    "PASS pending removal and committed lost answer recover Removed/Done without replaying a different contact change",
  );
  await click(emailPage, "Set up an authenticator app");
  await pending(emailPage, "Set up an authenticator app");
  assert.equal(await sealed(emailPage), 1);
  await emailPage.locator(".sidebar-dialog .preferences-close").click();
  await emailPage
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await emailPage
    .getByRole("menuitem", { name: "Sign out", exact: true })
    .click();
  await emailPage.getByLabel("Username or email").waitFor();
  for (let attempt = 0; attempt < 50 && (await sealed(emailPage)); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await sealed(emailPage),
    0,
    "signout removes the private pending envelope and its key material",
  );
  console.log(
    "PASS normal account signout purges the sealed pending receipt and key material",
  );
  assert.deepEqual(pageerrors, []);
} catch (error) {
  for (let index = 0; index < pages.length; index++)
    await pages[index].screenshot({
      path: "../../.cache/web-shots/security-pending-failure-" + index + ".png",
      mask: [
        pages[index].locator(
          ".totp-secret,.totp-qr,.backup-codes,input[type=password],input[autocomplete=one-time-code]",
        ),
      ],
    });
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
