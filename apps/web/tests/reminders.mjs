// Reminders: "Remind me" keeps a reminder in this browser, the message menu
// then offers to cancel it, the Reminders list shows and cancels it, and a due
// reminder fires when the page opens and leads back to its message.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_REMINDERS_USER || "webreminders";
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
const me = await call("/api/v1/auth/login", null, { username, password });
const room = await call("/api/v1/rooms", me.token, {
  name: "reminders-" + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
const send = (text) =>
  call("/api/v1/rooms/" + room.id + "/messages", me.token, {
    operation_id: crypto.randomUUID(),
    text,
  });
const later = await send("Remember the milk");
const due = await send("Call the plumber back");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
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
  await page.locator('[data-id="' + later.id + '"]').waitFor();
  await page.locator('[data-id="' + later.id + '"] .row-more').click();
  await page.getByRole("button", { name: "Remind me", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Pick a time", exact: true })
    .click();
  let picker = page.locator(".time-picker-dialog");
  await picker.waitFor();
  assert.equal(await picker.locator(".dialog-header").count(), 0);
  assert.equal(await picker.locator(".calendar-day").count(), 42);
  const selected = await picker
      .locator('.calendar-day[aria-pressed="true"]')
      .getAttribute("aria-label"),
    hour = await picker.getByLabel("Hour", { exact: true }).inputValue(),
    minute = await picker.getByLabel("Minute", { exact: true }).inputValue();
  await picker
    .getByRole("button", { name: "Previous year", exact: true })
    .click();
  await picker.locator(".calendar-day:not(.other-month)").first().click();
  assert.equal(
    await picker
      .getByRole("button", { name: "Remind me", exact: true })
      .isEnabled(),
    false,
    "past dates cannot create a reminder",
  );
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  const stored = () =>
    page.evaluate(async () => {
      const request = indexedDB.open("rocket-vibe-web");
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const get = db
          .transaction("reminders")
          .objectStore("reminders")
          .getAll();
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return rows;
    });
  assert.equal((await stored()).length, 0, "Cancel persists no reminder");
  await page.locator('[data-id="' + later.id + '"] .row-more').click();
  await page.getByRole("button", { name: "Remind me", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Pick a time", exact: true })
    .click();
  picker = page.locator(".time-picker-dialog");
  await picker.getByRole("button", { name: selected, exact: true }).click();
  await picker.getByLabel("Hour", { exact: true }).fill(hour);
  await picker.getByLabel("Minute", { exact: true }).fill(minute);
  await picker.getByRole("button", { name: "Remind me", exact: true }).click();
  await page.getByText(/^Reminder set for /).waitFor();
  const at = new Date(selected);
  at.setHours(Number(hour), Number(minute), 0, 0);
  const created = await stored();
  assert.equal(created.length, 1);
  assert.equal(created[0].message, later.id);
  assert.equal(Date.parse(created[0].due), at.getTime());
  await page.locator('[data-id="' + later.id + '"] .row-more').click();
  await page
    .getByRole("button", { name: /^Cancel reminder \(/ })
    .waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  console.log(
    "PASS native reminder calendar rejects past dates, Cancel stores nothing, and the exact selected reminder persists with its cancel action",
  );
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Reminders", exact: true }).click();
  const row = page.locator(".reminder-row");
  await row.waitFor();
  assert.match(await row.textContent(), /Remember the milk/);
  await page.screenshot({ path: "../../.cache/web-shots/reminders.png" });
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("No reminders", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("PASS the Reminders list shows and cancels it");
  // A reminder already due when the page opens fires once and leads back.
  const account = await page.evaluate(() => localStorage.getItem("rv-active"));
  await page.evaluate(
    async ({ account, message, room, roomName }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("rocket-vibe-web");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("reminders", "readwrite");
        tx.objectStore("reminders").put(
          {
            account,
            message,
            room,
            room_name: roomName,
            author: "webreminders",
            excerpt: "Call the plumber back",
            due: new Date(Date.now() - 60_000).toISOString(),
            created: new Date(Date.now() - 3_600_000).toISOString(),
          },
          account + ":" + message,
        );
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { account, message: due.id, room: room.id, roomName: room.name },
  );
  await page.goto(base + "/");
  const fired = page.locator("dialog[open]").filter({ hasText: "Reminder" });
  await fired.waitFor({ timeout: 20000 });
  assert.match(await fired.textContent(), /Call the plumber back/);
  await fired.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator('[data-id="' + due.id + '"]').waitFor();
  const left = await page.evaluate(
    async (key) =>
      new Promise((resolve) => {
        const request = indexedDB.open("rocket-vibe-web");
        request.onsuccess = () => {
          const get = request.result
            .transaction("reminders")
            .objectStore("reminders")
            .get(key);
          get.onsuccess = () => resolve(get.result ?? null);
        };
      }),
    account + ":" + due.id,
  );
  assert.equal(left, null, "a fired reminder is removed");
  console.log("PASS a due reminder fires on opening and leads to its message");
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/reminders-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
