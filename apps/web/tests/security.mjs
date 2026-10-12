import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417",
  username = process.env.RV_WEB_SECURITY_USER || "websecurity",
  password = "web-client-disposable-password";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.ok(username.startsWith("websec"));
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replaceAll(" ", ""))
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest(),
    offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US" }),
  page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const openSecurity = async () => {
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
};
const mailbox = async () =>
  JSON.parse(
    await readFile("../../.cache/smtp-mails.json", "utf8").catch(() => "[]"),
  );
async function latestCode(since) {
  for (let i = 0; i < 100; i++) {
    const messages = await mailbox();
    const message = messages.slice(since).at(-1);
    if (message) {
      const decoded = message
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      const code = /\b([0-9]{8})\b/.exec(decoded)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("SMTP fixture did not receive a code");
}
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".shell").waitFor();
  await openSecurity();
  await page
    .getByRole("button", { name: "Set up an authenticator app", exact: true })
    .click();
  await page.locator(".totp-secret").waitFor();
  await page
    .getByRole("img", { name: "QR code to scan with your authenticator app" })
    .waitFor();
  await page
    .locator(".security-account-status")
    .getByText("Two-factor authentication disabled", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("dialog").count(),
    1,
    "GTK setup stays within Security",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-security-setup-reference.png",
    mask: [page.locator(".totp-secret"), page.locator(".totp-qr")],
  });
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
  await page
    .locator(".security-account-status")
    .getByText("Two-factor authentication enabled", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("dialog").count(),
    1,
    "GTK backup-code acknowledgement stays within Security",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-security-codes-reference.png",
    mask: [page.locator(".backup-codes")],
  });
  assert.equal(
    (await page.locator(".backup-codes").textContent()).trim().split("\n")
      .length,
    10,
  );
  await page
    .getByRole("button", { name: "I have saved my codes", exact: true })
    .click();
  console.log("PASS TOTP enrollment and recovery codes");
  await page.locator(".sidebar-dialog .preferences-close").click();
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const factor = page.locator(".factor-step");
  await factor.locator('input[autocomplete="one-time-code"]').fill("000000");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await factor.locator(".login-error:not(:empty)").waitFor();
  assert.equal(await page.locator(".shell").count(), 0);
  await new Promise((resolve) =>
    setTimeout(resolve, 30100 - (Date.now() % 30000)),
  );
  await factor
    .locator('input[autocomplete="one-time-code"]')
    .fill(totp(secret));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.locator(".shell").waitFor();
  console.log(
    "PASS wrong second factor cannot sign in; correct TOTP resumes the account",
  );
  await openSecurity();
  await page
    .getByRole("button", { name: "Disable authenticator app", exact: true })
    .click();
  await page
    .locator(".alert-dialog")
    .getByRole("button", { name: "Disable authenticator app", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Set up an authenticator app", exact: true })
    .waitFor();
  console.log("PASS TOTP removal with a recent complete proof");
  const start = (await mailbox()).length;
  await page
    .getByLabel("New email address", { exact: true })
    .fill(username + "@example.test");
  await page
    .locator(".preferences-page")
    .getByRole("button", { name: "Send a verification code", exact: true })
    .click();
  await page.getByLabel("Email code (8 digits)", { exact: true }).waitFor();
  assert.equal(
    await page.locator("dialog").count(),
    1,
    "GTK email verification stays within Security",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-security-email-reference.png",
  });
  await page.locator(".sidebar-dialog .preferences-close").click();
  await openSecurity();
  await page.getByLabel("Email code (8 digits)", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Continue email verification", exact: true })
      .count(),
    0,
    "GTK resumes the persisted email flow directly in Security",
  );
  const code = await latestCode(start);
  await page.getByLabel("Email code (8 digits)", { exact: true }).fill(code);
  await page
    .getByRole("button", { name: "Verify this address", exact: true })
    .click();
  await page
    .getByText("The address has been verified.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove this email address", exact: true })
    .waitFor();
  console.log("PASS verified email delivered through real TLS SMTP");
  await page
    .getByRole("button", { name: "Enable email codes", exact: true })
    .click();
  await page
    .locator(".alert-dialog")
    .getByRole("button", { name: "Enable email codes", exact: true })
    .click();
  await page.locator(".backup-codes").waitFor();
  await page
    .getByRole("button", { name: "I have saved my codes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Disable email codes", exact: true })
    .waitFor();
  await page.locator(".sidebar-dialog .preferences-close").click();
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const loginStart = (await mailbox()).length;
  await factor.getByLabel("Confirmation method").selectOption("email");
  await factor.getByRole("button", { name: "Send code", exact: true }).click();
  await factor
    .locator('input[autocomplete="one-time-code"]')
    .fill(await latestCode(loginStart));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.locator(".shell").waitFor();
  console.log("PASS email second factor authenticates through TLS delivery");
  await openSecurity();
  await page
    .getByRole("button", { name: "Disable email codes", exact: true })
    .click();
  await page
    .locator(".alert-dialog")
    .getByRole("button", { name: "Disable email codes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable email codes", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Remove this email address", exact: true })
    .click();
  await page
    .locator(".alert-dialog")
    .getByRole("button", { name: "Remove this email address", exact: true })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove this email address", exact: true })
    .waitFor({ state: "detached" });
  console.log("PASS email factor and verified contact removal");
  assert.deepEqual(errors, []);
} catch (error) {
  console.log("Security UI:", await page.locator(".toast").allTextContents());
  console.log("Security browser errors:", errors);
  await page.screenshot({
    path: "../../.cache/web-shots/security-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
