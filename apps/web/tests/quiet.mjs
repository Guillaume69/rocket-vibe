// Do not disturb in Settings > Notifications: a mute and quiet hours reach
// the server, each save keeping the other field.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_QUIET_USER || "webquiet";
const password = "web-client-disposable-password";
const login = await (
  await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username, password: password }),
  })
).json();
const own = async () =>
  (
    await fetch(base + "/api/v1/me/profile", {
      headers: { Authorization: "Bearer " + login.token },
    })
  ).json();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  timezoneId: "Europe/Paris",
  viewport: { width: 1280, height: 800 },
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.getByText("Do not disturb").waitFor();
  await page.getByLabel("Mute notifications").selectOption("hour");
  await page
    .locator(".action-row-subtitle", { hasText: /^Until [0-9]/ })
    .waitFor();
  let prefs = (await own()).preferences;
  assert.ok(
    prefs.muted_until &&
      Date.parse(prefs.muted_until) > Date.now() + 50 * 60_000,
    JSON.stringify(prefs),
  );
  console.log("PASS mute for an hour stored", prefs.muted_until);
  await page.getByLabel("Quiet hours").check();
  await page.waitForTimeout(800);
  prefs = (await own()).preferences;
  assert.deepEqual(prefs.quiet_hours, {
    start_minute: 1320,
    end_minute: 480,
    time_zone: "Europe/Paris",
  });
  assert.ok(prefs.muted_until, "the mute is kept by the schedule's save");
  console.log("PASS quiet hours stored with the browser's zone, mute kept");
  await page.getByLabel("From").fill("21:30");
  await page.getByLabel("From").press("Enter");
  await page.waitForTimeout(800);
  prefs = (await own()).preferences;
  assert.equal(prefs.quiet_hours.start_minute, 21 * 60 + 30);
  await page.getByLabel("Mute notifications").selectOption("off");
  await page.waitForTimeout(800);
  prefs = (await own()).preferences;
  assert.equal(prefs.muted_until ?? null, null);
  assert.equal(
    prefs.quiet_hours.start_minute,
    21 * 60 + 30,
    "unmuting keeps the schedule",
  );
  await page.getByLabel("Quiet hours").uncheck();
  await page.waitForTimeout(800);
  prefs = (await own()).preferences;
  assert.equal(prefs.quiet_hours ?? null, null);
  console.log("PASS edit, unmute and switch off, each keeping the other");
  const toasts = await page.locator(".toast").allTextContents();
  assert.deepEqual(toasts, [], "no error toast");
  console.log("PASS no error toast");
  await page.screenshot({ path: "../../.cache/web-shots/quiet.png" });
} catch (error) {
  await page.screenshot({ path: "../../.cache/web-shots/quiet-failure.png" });
  throw error;
} finally {
  await browser.close();
}
