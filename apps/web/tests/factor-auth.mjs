import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417",
  names = [
    process.env.RV_WEB_FACTOR_USER || "websecfactorci",
    process.env.RV_WEB_FACTOR_EMAIL_USER || "websecfactoremailci",
  ],
  password = "web-client-disposable-password",
  evidence = "../../.cache/web-shots";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.ok(names.every((name) => /^websec[a-z0-9]+$/.test(name)));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true }),
  contexts = [],
  pages = [],
  errors = [],
  results = [];
const pass = (name) => {
  results.push(name);
  console.log("PASS " + name);
};
function totp(secret) {
  const bits = [...secret.replaceAll(" ", "")]
      .map((char) =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
          .indexOf(char)
          .toString(2)
          .padStart(5, "0"),
      )
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
}
async function login(page, name) {
  await page.getByLabel("Username or email").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function openSecurity(page) {
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await page.locator(".security-account-status").waitFor();
}
async function logout(page) {
  if (await page.locator(".sidebar-dialog").count())
    await page.locator(".preferences-close").click();
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username or email").waitFor();
}
async function db(page, action, argument) {
  return page.evaluate(
    async ({ action, argument }) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("rocket-vibe-web", 6);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (action === "account")
          return await new Promise((resolve) => {
            const request = database
              .transaction("accounts")
              .objectStore("accounts")
              .getAll();
            request.onsuccess = () => resolve(request.result[0]);
          });
        if (action === "probe")
          return await new Promise((resolve) => {
            const transaction = database.transaction("operations", "readwrite");
            transaction
              .objectStore("operations")
              .put({ marker: "purge-probe" }, argument);
            transaction.oncomplete = () => resolve();
          });
        return await new Promise((resolve) => {
          const store = database
              .transaction("operations")
              .objectStore("operations"),
            keys = store.getAllKeys(),
            values = store.getAll();
          values.onsuccess = () =>
            resolve(
              values.result.map((value, i) => ({
                key: keys.result[i],
                version: value.version,
                algorithm: value.key?.algorithm?.name,
                extractable: value.key?.extractable,
                ciphertext: value.ciphertext instanceof ArrayBuffer,
                plain: JSON.stringify(value),
              })),
            );
        });
      } finally {
        database.close();
      }
    },
    { action, argument },
  );
}
const account = (page) => db(page, "account");
const records = (page) => db(page, "records");
async function factors(page) {
  const current = await account(page),
    response = await fetch(base + "/api/v1/me/factors", {
      headers: { Authorization: "Bearer " + current.session.token },
    });
  assert.equal(response.status, 200);
  return response.json();
}
const waitFor = async (condition, description) => {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(description);
};
const mailbox = async () =>
  JSON.parse(
    await readFile("../../.cache/smtp-mails.json", "utf8").catch(() => "[]"),
  );
const recipientMails = async (address, since) =>
  (await mailbox()).slice(since).filter((message) => message.includes(address));
async function emailCode(address, since) {
  let code;
  await waitFor(async () => {
    const message = (await recipientMails(address, since)).at(-1);
    if (!message) return false;
    const decoded = message
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    code = /\b([0-9]{8})\b/.exec(decoded)?.[1];
    return !!code;
  }, "Own TLS mailbox did not receive a code");
  return code;
}
const field = (page) =>
  page.locator('.factor-step input[autocomplete="one-time-code"]');
const confirm = (page) =>
  page
    .locator(".factor-step")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
async function privateRecord(page, challenge, forbidden) {
  const stored = (await records(page)).filter((item) =>
    item.key.endsWith(":security-login:" + challenge),
  );
  assert.equal(stored.length, 1);
  assert.ok(stored[0].key.split(":").length >= 5);
  assert.equal(stored[0].version, 1);
  assert.equal(stored[0].algorithm, "AES-GCM");
  assert.equal(stored[0].extractable, false);
  assert.equal(stored[0].ciphertext, true);
  assert.ok(forbidden.every((value) => !stored[0].plain.includes(value)));
  assert.ok(
    !(await records(page)).some((item) => item.key === "factor:" + challenge),
  );
}
async function clean(page) {
  await waitFor(
    async () =>
      !(await records(page)).some(
        (item) =>
          item.key.includes(":security-login:") ||
          item.key.startsWith("factor:"),
      ),
    "Factor receipt/key was not retired",
  );
}
async function startPage(name) {
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  contexts.push(context);
  const page = await context.newPage();
  pages.push(page);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  if (process.env.RV_WEB_EXPECT_ENTRY)
    assert.ok(
      (
        await page.locator('script[type="module"]').getAttribute("src")
      ).endsWith(process.env.RV_WEB_EXPECT_ENTRY),
    );
  await login(page, name);
  await page.locator(".status-dot.online").waitFor();
  return page;
}
try {
  for (const language of ["en", "fr"]) {
    const context = await browser.newContext({
      locale: language === "fr" ? "fr-FR" : "en-US",
    });
    contexts.push(context);
    await context.addInitScript(
      (language) => localStorage.setItem("rv-language", language),
      language,
    );
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const rejectedUser = names[0] + "rejected" + language;
    await page.locator('input[autocomplete="username"]').fill(rejectedUser);
    await page
      .locator('input[autocomplete="current-password"]')
      .fill("incorrect-disposable-password");
    await page.locator('button[type="submit"]').click();
    const message = page.locator(".login-error:not([hidden])");
    await message.waitFor();
    assert.equal(
      await message.textContent(),
      language === "fr"
        ? "Identifiant ou mot de passe refusé."
        : "Username or password rejected.",
    );
    for (const [mode, index, expected] of [
      [
        "signup",
        0,
        language === "fr"
          ? "Invitation refusée : vérifie le code, sa validité et les identifiants saisis. Si le compte a déjà été créé, connecte-toi normalement."
          : "Invitation rejected: check the code, its validity and your credentials. If the account already exists, sign in normally.",
      ],
      [
        "recovery",
        1,
        language === "fr"
          ? "Code refusé ou expiré. Vérifie identifiant et code. Si le mot de passe a déjà été changé, connecte-toi avec le nouveau."
          : "Code rejected or expired. Check username and code. If the password was already changed, sign in with the new one.",
      ],
    ]) {
      await page.locator(".login-modes input").nth(index).check();
      await page
        .locator('input[autocomplete="username"]')
        .fill(
          mode === "signup" ? "websecinvalidinvite" + language : rejectedUser,
        );
      await page
        .locator(
          'input[autocomplete="current-password"],input[autocomplete="new-password"]',
        )
        .fill(password);
      await page.locator(".login-account-code input").fill("f".repeat(64));
      await page.locator('button[type="submit"]').click();
      await message.waitFor();
      assert.equal(await message.textContent(), expected);
      assert.ok(!/\b(?:[a-z]+_){1,}[a-z]+\b/.test(await message.textContent()));
    }
    // A future gateway/server code must not inherit Object members as a caption.
    // This controls only error transport; all authentication/receipt cases below
    // continue to exercise the real server and actual one-time codes.
    for (const checkbox of await page.locator(".login-modes input").all())
      await checkbox.uncheck();
    await page.locator('input[autocomplete="username"]').fill(rejectedUser);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    for (const code of ["constructor", "__proto__"]) {
      const path = "**/api/v1/auth/start";
      const refusal = (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            code,
            request_id: "future-error-caption-fixture",
          }),
        });
      await page.route(path, refusal);
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/v1/auth/start") &&
            response.status() === 400,
        ),
        page.locator('button[type="submit"]').click(),
      ]);
      await message.waitFor();
      assert.equal(
        await message.textContent(),
        language === "fr"
          ? "Identifiant ou mot de passe refusé."
          : "Username or password rejected.",
      );
      assert.ok(!(await message.textContent()).includes(code));
      await page.unroute(path, refusal);
    }
    await context.close();
  }
  pass(
    "actual rejected password, invitation and recovery plus unknown inherited codes show native English/French captions without wire keys",
  );
  const page = await startPage(names[0]);
  await openSecurity(page);
  await page
    .getByRole("button", { name: "Set up an authenticator app", exact: true })
    .click();
  await page.locator(".totp-secret").waitFor();
  const secret = await page.locator(".totp-secret").textContent();
  await page
    .getByLabel("Authenticator app code", { exact: true })
    .fill(totp(secret));
  await page
    .getByRole("button", {
      name: "Enable two-factor authentication",
      exact: true,
    })
    .click();
  await page.locator(".backup-codes").waitFor();
  const codes = (await page.locator(".backup-codes").textContent())
    .trim()
    .split("\n");
  assert.equal(codes.length, 10);
  await page
    .getByRole("button", { name: "I have saved my codes", exact: true })
    .click();
  const initial = await account(page);
  assert.equal((await factors(page)).backup_codes_remaining, 10);
  await logout(page);
  await login(page, names[0]);
  await page.locator(".factor-step").waitFor();
  assert.deepEqual(
    await page
      .getByLabel("Confirmation method")
      .locator("option")
      .allTextContents(),
    ["Authenticator app", "Backup code"],
  );
  assert.equal(
    await page
      .locator(".factor-step > select")
      .evaluate((element) => element.getBoundingClientRect().height),
    34,
  );
  assert.equal(
    await page
      .locator(".factor-step > .cta")
      .evaluate((element) => element.getBoundingClientRect().height),
    62,
  );
  assert.match(await page.locator(".step-intro").textContent(), /\n/);
  await page.getByLabel("Confirmation method").selectOption("recovery_code");
  await field(page).fill("invalid-recovery-code");
  await confirm(page);
  await page.getByText("Code rejected. Try again.", { exact: true }).waitFor();
  await page.locator(".factor-resume").waitFor();
  pass(
    "native factor captions, 34px method selector, 62px Confirm and refusal/saved-finish hint",
  );
  let accepted, first, replay;
  const routePath = "**/api/v1/auth/factors/verify";
  await page.route(routePath, async (route) => {
    const input = route.request().postDataJSON();
    if (!accepted) {
      first = input;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      accepted = await response.json();
      await route.abort("failed");
    } else {
      replay = input;
      await route.continue();
    }
  });
  await field(page).fill(codes[0]);
  await confirm(page);
  await page.locator(".login-error:not([hidden])").waitFor();
  assert.ok(accepted);
  await privateRecord(page, first.challenge_id, [
    codes[0],
    first.next_token,
    password,
  ]);
  const remaining = await fetch(base + "/api/v1/me/factors", {
    headers: { Authorization: "Bearer " + accepted.token },
  });
  assert.equal((await remaining.json()).backup_codes_remaining, 9);
  await field(page).fill("");
  await confirm(page);
  await page.locator(".status-dot.online").waitFor();
  assert.equal(replay.operation_id, first.operation_id);
  assert.ok(
    replay.next_token === first.next_token,
    "Original successor token is preserved",
  );
  assert.equal(replay.challenge_id, first.challenge_id);
  assert.equal(replay.code, "");
  assert.equal((await factors(page)).backup_codes_remaining, 9);
  await clean(page);
  await page.unroute(routePath);
  pass(
    "real committed lost finish replays blank with exact original IDs and consumes one backup code",
  );
  // Normal logout must purge the whole account-prefixed private operations namespace.
  await db(page, "probe", initial.key + ":security-login:purge-probe");
  await logout(page);
  assert.ok(
    !(await records(page)).some((item) =>
      item.key.startsWith(initial.key + ":"),
    ),
  );
  await login(page, names[0]);
  await page.locator(".factor-step").waitFor();
  await field(page).fill("000000");
  await confirm(page);
  await page.getByText("Code rejected. Try again.", { exact: true }).waitFor();
  assert.equal(
    (await records(page)).filter((item) =>
      item.key.includes(":security-login:"),
    ).length,
    1,
  );
  await page.locator(".factor-step .back-link").click();
  await page.getByLabel("Username or email").waitFor();
  await clean(page);
  pass(
    "Back retires the exact unfinished receipt and normal account logout purges its private namespace",
  );

  const mailPage = await startPage(names[1]),
    address = names[1] + "@example.test";
  await openSecurity(mailPage);
  const verificationStart = (await mailbox()).length;
  await mailPage.getByLabel("New email address", { exact: true }).fill(address);
  await mailPage
    .locator(".preferences-page")
    .getByRole("button", { name: "Send a verification code", exact: true })
    .click();
  await mailPage
    .getByLabel("Email code (8 digits)", { exact: true })
    .fill(await emailCode(address, verificationStart));
  await mailPage
    .getByRole("button", { name: "Verify this address", exact: true })
    .click();
  await mailPage
    .getByText("The address has been verified.", { exact: true })
    .waitFor();
  await mailPage.getByRole("button", { name: "Done", exact: true }).click();
  await mailPage
    .getByRole("button", { name: "Enable email codes", exact: true })
    .click();
  await mailPage
    .locator(".alert-dialog")
    .getByRole("button", { name: "Enable email codes", exact: true })
    .click();
  await mailPage.locator(".backup-codes").waitFor();
  await mailPage
    .getByRole("button", { name: "I have saved my codes", exact: true })
    .click();
  await logout(mailPage);
  await login(mailPage, names[1]);
  await mailPage.locator(".factor-step").waitFor();
  await mailPage.getByLabel("Confirmation method").selectOption("email");
  const deliveryStart = (await mailbox()).length;
  let candidate,
    starts = 0;
  const resumes = [];
  await mailPage.route("**/api/v1/auth/factors/email/start", async (route) => {
    starts++;
    candidate = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort("failed");
  });
  mailPage.on("request", (request) => {
    if (request.url().endsWith("/api/v1/auth/factors/email/resume"))
      resumes.push(request.postDataJSON());
  });
  await mailPage
    .getByRole("button", { name: "Send code", exact: true })
    .click();
  await mailPage
    .getByText(
      "Delivery is unconfirmed. Resume this request before resending.",
      { exact: true },
    )
    .waitFor();
  await privateRecord(mailPage, candidate.challenge_id, [
    candidate.operation_id,
    candidate.delivery_id,
    password,
  ]);
  const deliveredCode = await emailCode(address, deliveryStart);
  await mailPage
    .getByRole("button", { name: "Resume delivery", exact: true })
    .click();
  await mailPage
    .getByRole("button", { name: "Resend code", exact: true })
    .waitFor();
  assert.ok(
    JSON.stringify(resumes.at(-1)) === JSON.stringify(candidate),
    "Resume uses the original private receipt IDs",
  );
  assert.equal(starts, 1);
  assert.equal((await recipientMails(address, deliveryStart)).length, 1);
  await mailPage
    .getByRole("button", { name: "Resume delivery", exact: true })
    .click();
  await mailPage
    .getByRole("button", { name: "Resume delivery", exact: true })
    .waitFor({ state: "visible" });
  await mailPage
    .getByRole("button", { name: "Resend code", exact: true })
    .click();
  await mailPage.locator(".login-error:not([hidden])").waitFor();
  assert.equal(starts, 1);
  assert.ok(
    resumes.every(
      (input) => JSON.stringify(input) === JSON.stringify(candidate),
    ),
  );
  assert.equal((await recipientMails(address, deliveryStart)).length, 1);
  pass(
    "lost real TLS email delivery resumes the original receipt without duplicate mail and enforces resend cooldown",
  );
  await field(mailPage).fill(deliveredCode);
  await confirm(mailPage);
  await mailPage.locator(".status-dot.online").waitFor();
  await clean(mailPage);
  pass(
    "the original delivered email code still authenticates and retires its encrypted delivery/finish receipts",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    evidence + "/factor-auth-results.json",
    JSON.stringify(
      {
        base,
        entry: process.env.RV_WEB_EXPECT_ENTRY || "source-preview",
        groups: results,
        pageerrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const [index, page] of pages.entries())
    await page
      .screenshot({
        path: evidence + "/factor-auth-failure-" + index + ".png",
        mask: [
          page.locator("input"),
          page.locator(".totp-secret,.totp-qr,.backup-codes"),
        ],
      })
      .catch(() => {});
  console.log("Factor browser errors:", errors);
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
