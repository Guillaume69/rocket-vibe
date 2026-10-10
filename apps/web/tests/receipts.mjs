// Read receipts: a member's read shows live under my latest message, and
// turning receipts off in Settings > My account hides them both ways.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const aliceName = process.env.RV_WEB_RECEIPTS_USER || "webreceipts";
const bobName = process.env.RV_WEB_RECEIPTS_PEER || "webreceiptspeer";
const password = "web-client-disposable-password";
const call = async (path, token, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  assert.ok(
    response.ok,
    path + " " + response.status + " " + JSON.stringify(value),
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
const room = await call("/api/v1/rooms", alice.token, {
  name: "receipts-" + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
await call(
  "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
  alice.token,
  null,
);
const sent = await call("/api/v1/rooms/" + room.id + "/messages", alice.token, {
  operation_id: crypto.randomUUID(),
  text: "Did you read this?",
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(aliceName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.locator('[data-id="' + sent.id + '"]').waitFor();
  assert.equal(
    await page.locator(".seen-receipt").count(),
    0,
    "unread: no line",
  );
  await call("/api/v1/rooms/" + room.id + "/read", bob.token, {
    root_position: sent.position,
    reply_position: "0",
  });
  const line = page.locator(".seen-receipt");
  await line.waitFor({ timeout: 15000 });
  assert.equal(
    await line.textContent(),
    "Seen by " + (bob.user.display_name || bob.user.username),
  );
  console.log("PASS a read shows live as Seen by its reader");
  await page.screenshot({ path: "../../.cache/web-shots/receipts-seen.png" });
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "My account", exact: true }).click();
  await page.getByLabel("Share read receipts").uncheck();
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await line.waitFor({ state: "detached", timeout: 15000 });
  console.log("PASS turning receipts off hides the others' reads");
  await page.screenshot({ path: "../../.cache/web-shots/receipts.png" });
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/receipts-failure.png",
  });
  throw error;
} finally {
  await browser.close();
  // Receipts back on, so the next run starts from the default.
  const own = await call("/api/v1/me/profile", alice.token);
  await fetch(base + "/api/v1/me/preferences", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + alice.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation_id: crypto.randomUUID(),
      expected_revision: own.preferences.revision,
      language: own.preferences.language,
      clock_24h: own.preferences.clock_24h,
      push_enabled: own.preferences.push_enabled,
      push_mentions_only: own.preferences.push_mentions_only,
      desktop_notifications: own.preferences.desktop_notifications,
      share_read_receipts: true,
    }),
  });
}
