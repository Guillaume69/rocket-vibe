import assert from "node:assert/strict";
import { fixture } from "./crypto-browser.mjs";

/** A visible disabled row is not a publication receipt. The long E2EE run may
 * cross the recent-proof deadline; complete the actual renewal UI if shown. */
export async function publishRootBackup(target, action) {
  const accepted = target.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/e2ee/root-backup" &&
      response.request().method() === "POST" &&
      response.status() === 200,
    { timeout: 60000 },
  );
  // Keep a UI failure from producing an unrelated unhandled timeout later.
  accepted.catch(() => {});
  await action();
  await target.waitForFunction(() => {
    const proof = document.querySelector(
      'dialog[open] input[autocomplete="current-password"]',
    );
    const review = [
      ...document.querySelectorAll(".crypto-settings-controls button"),
    ].find((button) => button.textContent === "Review backup");
    return !!proof || !!(review && !review.disabled);
  });
  const password = target
    .locator("dialog[open]")
    .last()
    .getByLabel("Password", { exact: true });
  if (await password.isVisible()) {
    await password.fill("web-client-disposable-password");
    await target
      .locator("dialog[open]")
      .last()
      .getByRole("button", { name: "Verify", exact: true })
      .click();
  }
  const receipt = await (await accepted).json();
  const active = (await fixture(target, "/api/v1/e2ee/root-backup")).active;
  assert.ok(
    active,
    "Server has an accepted root backup before fresh-profile recovery",
  );
  assert.deepEqual(active.receipt, receipt);
  // The panel re-renders once its busy action settles: wait for that state
  // rather than read the button while the receipt is still being applied.
  await target.waitForFunction(() =>
    [...document.querySelectorAll(".crypto-settings-controls button")].some(
      (button) => button.textContent === "Review backup" && !button.disabled,
    ),
  );
  return receipt;
}
