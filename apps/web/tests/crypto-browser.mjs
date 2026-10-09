import assert from "node:assert/strict";
export const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3418";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
export async function fixture(target, path, method = "GET", input) {
  return target.evaluate(
    async ({ path, method, input }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("rocket-vibe-web");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const account = await new Promise((resolve, reject) => {
        const request = db
          .transaction("accounts")
          .objectStore("accounts")
          .get(localStorage.getItem("rv-active"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const response = await fetch(path, {
        method,
        headers: {
          Authorization: "Bearer " + account.session.token,
          "Content-Type": "application/json",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      if (!response.ok) throw Error("Fixture HTTP " + response.status);
      return response.status === 204 ? null : response.json();
    },
    { path, method, input },
  );
}
export async function closeDialog(target) {
  const count = await target.locator("dialog[open]").count();
  await target
    .locator("dialog[open]")
    .last()
    .locator(".dialog-header button")
    .click();
  await target.waitForFunction(
    (expected) => document.querySelectorAll("dialog[open]").length < expected,
    count,
  );
}
export async function identity(target, user) {
  await target.goto(base);
  await target.getByLabel("Username or email").fill(user);
  await target
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await target.getByRole("button", { name: "Sign in", exact: true }).click();
  await target.locator(".status-dot.online").waitFor();
  await target.getByRole("button", { name: "Settings", exact: true }).click();
  await target.locator('[data-category="encryption"]').click();
  for (const name of [
    "Create identity or accept the displayed fingerprint",
    "Review this device’s request",
    "Approve the displayed fingerprints",
    "Install approval and register this device",
  ])
    await target.getByRole("button", { name, exact: true }).click();
  await target
    .getByText("Identity and device registered", { exact: true })
    .waitFor();
  const fingerprint = await target
    .locator(".crypto-fingerprint .action-row-subtitle")
    .first()
    .innerText();
  await target.locator(".settings-dialog .preferences-close").click();
  return fingerprint;
}
export async function groupDialog(target, room) {
  await target.locator('[data-room="' + room + '"]').click();
  await target.locator(".room-heading").click();
  await target
    .locator("dialog[open]")
    .getByRole("button", { name: "Room encryption", exact: true })
    .click();
  await target
    .locator(".crypto-group-dialog .preferences-group,.crypto-group-dialog p")
    .first()
    .waitFor();
  if (
    !(await target.locator(".crypto-group-dialog .preferences-group").count())
  )
    throw Error(await target.locator(".crypto-group-dialog").innerText());
}
export async function pin(target, name, expected) {
  await target.locator(".room-heading").click();
  await target
    .locator(".member-row")
    .getByRole("button", { name, exact: true })
    .click();
  await target
    .getByRole("button", { name: "Verify encryption identity", exact: true })
    .click();
  if (expected)
    assert.equal(
      await target
        .locator("dialog[open]")
        .last()
        .locator(".crypto-fingerprint .action-row-subtitle")
        .first()
        .innerText(),
      expected,
    );
  await target
    .getByRole("button", {
      name: "Save this fingerprint as unverified",
      exact: true,
    })
    .click();
  await target
    .getByRole("button", {
      name: "Mark the compared fingerprint verified",
      exact: true,
    })
    .click();
  await target
    .locator("dialog[open]")
    .last()
    .getByRole("button")
    .filter({ hasText: "Certificate unapproved or expired" })
    .click();
  await target
    .getByRole("button", {
      name: "Approve this device certificate",
      exact: true,
    })
    .click();
  await target.getByText("Certificate approved", { exact: false }).waitFor();
  for (let i = 0; i < 3; i++) await closeDialog(target);
}
