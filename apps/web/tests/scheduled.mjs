// Scheduled messages: "Send later" keeps the text on the server, the chip
// counts it, and Cancel in its list removes it before it is ever sent.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_SCHEDULED_USER || "webscheduled";
const password = "web-client-disposable-password";
const call = async (path, token, body, method) => {
  const response = await fetch(base + path, {
    method: method || (body === undefined ? "GET" : "POST"),
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
const me = await call("/api/v1/auth/login", null, { username, password });
// A rerun starts clean: earlier runs' leftovers go.
for (const old of (await call("/api/v1/scheduled", me.token)).messages)
  await call("/api/v1/scheduled/" + old.id, me.token, undefined, "DELETE");
const room = await call("/api/v1/rooms", me.token, {
  name: "scheduled-" + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  const input = page.locator(".room-content .rich-composer");
  await input.waitFor();
  await input.fill("See you in an hour");
  const before = Date.now();
  await page
    .locator(".room-content")
    .getByRole("button", { name: "Send later", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "In 1 hour", exact: true }).click();
  const chip = page.locator(".scheduled-chip");
  await chip.waitFor({ timeout: 15000 });
  assert.equal((await chip.textContent())?.trim(), "1 scheduled");
  assert.equal((await input.textContent())?.trim(), "", "the composer clears");
  const list = (await call("/api/v1/scheduled", me.token)).messages;
  assert.equal(list.length, 1);
  assert.equal(list[0].room_id, room.id);
  assert.equal(list[0].text, "See you in an hour");
  const ahead = Date.parse(list[0].send_at) - before;
  assert.ok(ahead > 59 * 60_000 && ahead < 61 * 60_000, "in one hour");
  const history = await call(
    "/api/v1/rooms/" + room.id + "/messages?limit=20",
    me.token,
  );
  assert.ok(
    !JSON.stringify(history).includes("See you in an hour"),
    "nothing is sent yet",
  );
  console.log("PASS Send later keeps the text on the server and counts it");
  await page.screenshot({ path: "../../.cache/web-shots/scheduled.png" });
  await chip.click();
  await page.locator(".scheduled-row").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await chip.waitFor({ state: "detached", timeout: 15000 });
  assert.equal((await call("/api/v1/scheduled", me.token)).messages.length, 0);
  console.log("PASS Cancel removes it before it is sent");
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/scheduled-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
