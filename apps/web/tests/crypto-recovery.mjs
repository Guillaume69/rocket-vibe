import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import {
  base,
  fixture,
  identity,
  groupDialog,
  closeDialog,
  openSettings,
} from "./crypto-browser.mjs";
import { publishRootBackup } from "./crypto-recovery-helper.mjs";

const user = process.env.RV_WEB_RECOVERY_USER,
  pg = process.env.RV_WEB_RECOVERY_PG || "rv-web-gtk-parity-db";
assert.match(user || "", /^webcryptorecovery[a-z0-9]+$/);
assert.match(pg, /^[a-zA-Z0-9_.-]+$/);
const expire = () =>
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
        user +
        "'); UPDATE reauthentication_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE username='" +
        user +
        "'); COMMIT;",
    ],
    { stdio: "pipe" },
  );
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({ locale: "en-US" }),
  page = await context.newPage(),
  errors = [],
  publications = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    new URL(request.url()).pathname === "/api/v1/e2ee/root-backup" &&
    request.method() === "POST"
  )
    publications.push(request.postData());
});
const click = (target, name) =>
  target.getByRole("button", { name, exact: true }).click();
const encryption = async (target) => {
  await openSettings(target);
  await target.locator('[data-category="encryption"]').click();
  await target
    .getByText("Identity and device registered", { exact: true })
    .waitFor();
};
try {
  const fingerprint = await identity(page, user);
  const room = (
    await fixture(page, "/api/v1/rooms", "POST", {
      operation_id: crypto.randomUUID(),
      name: "recovery-proof-" + Date.now(),
      private: true,
    })
  ).id;
  await groupDialog(page, room);
  await click(page, "Prepare this device for invitations");
  await click(page, "Review group creation");
  await click(page, "Confirm this review");
  await page
    .getByText("Group recorded on this device", { exact: true })
    .waitFor();
  await closeDialog(page);
  await closeDialog(page);
  const text = "Recovery proof retained private journal " + Date.now();
  await page.locator(".room-content .rich-composer").fill(text);
  await page.locator(".room-content .rich-composer").press("Enter");
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: text })
    .waitFor();
  await encryption(page);
  await click(page, "Review backup");
  await click(page, "Prepare this backup");
  await click(page, "Show recovery code");
  const code = await page
    .locator(".crypto-code")
    .filter({ hasText: "rvk1-" })
    .innerText();
  assert.equal(code.length, 78);
  expire();
  await click(page, "I have saved this code: publish backup");
  const proof = page.locator("dialog[open]").last();
  await proof.getByLabel("Password", { exact: true }).waitFor();
  assert.equal((await fixture(page, "/api/v1/e2ee/root-backup")).active, null);
  await proof.locator(".dialog-header button").click();
  await page
    .getByRole("button", { name: "Resume confirmation", exact: true })
    .click({ trial: true });
  assert.equal(
    await page
      .getByRole("button", { name: "Resume confirmation", exact: true })
      .isEnabled(),
    true,
  );
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await encryption(page);
  assert.equal(
    await page
      .getByRole("button", { name: "Resume confirmation", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(
    await page.locator(".crypto-code").filter({ hasText: "rvk1-" }).count(),
    0,
  );
  console.log(
    "PASS expired proof and canceled renewal retain the saved original protected backup across reload",
  );
  const accepted = await publishRootBackup(page, () =>
    click(page, "Resume confirmation"),
  );
  assert.ok(
    publications.length >= 2 &&
      publications.every((value) => value === publications[0]),
    "Proof renewal resumes the exact original encrypted publication",
  );
  assert.equal(accepted.root_fingerprint, fingerprint);
  console.log(
    "PASS actual renewed proof publishes one original backup and verified server receipt",
  );
  await click(page, "Enable the history backup");
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("button", { name: "Enable the history backup", exact: true })
    .click();
  await click(page, "Show the history code");
  const history = await page
    .locator(".crypto-code")
    .filter({ hasText: "rvh1-" })
    .innerText();
  await click(page, "I have saved this code: enable");
  await click(page, "Back up now");
  await page.getByText(/[1-9]\d* pages? uploaded/).waitFor();
  const fresh = await (await browser.newContext({ locale: "en-US" })).newPage();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(base);
  await fresh.getByLabel("Username or email").fill(user);
  await fresh
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await click(fresh, "Sign in");
  await fresh.locator(".status-dot.online").waitFor();
  await openSettings(fresh);
  await fresh.locator('[data-category="encryption"]').click();
  await fresh.getByLabel("Recovery code", { exact: true }).fill(code);
  await click(fresh, "Verify code and backup");
  await fresh
    .locator("dialog[open]")
    .last()
    .getByRole("button", {
      name: "Recover this identity on this device",
      exact: true,
    })
    .click();
  await fresh.waitForFunction(
    () => document.querySelectorAll("dialog[open]").length === 1,
  );
  for (const name of [
    "Create identity or accept the displayed fingerprint",
    "Review this device’s request",
    "Approve the displayed fingerprints",
    "Install approval and register this device",
  ])
    await click(fresh, name);
  await fresh
    .getByText("Identity and device registered", { exact: true })
    .waitFor();
  assert.equal(
    await fresh
      .locator(".crypto-fingerprint .action-row-subtitle")
      .first()
      .innerText(),
    fingerprint,
  );
  await fresh.getByLabel("History code", { exact: true }).fill(history);
  await click(fresh, "Join with the code");
  await click(fresh, "Restore the history");
  await fresh.getByText(/[1-9]\d* messages? restored/).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "PASS fresh browser profile restores the published root, new leaf and actual private journal with separate history code; zero pageerrors",
  );
} finally {
  await browser.close();
}
