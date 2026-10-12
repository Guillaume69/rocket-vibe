import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startupStorage } from "./startup-storage.mjs";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const password = "web-client-disposable-password",
  username = process.env.RV_WEB_SHELL_USER || "webshell";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  await startupStorage(browser, base);
  await page.goto(base);
  if (process.env.RV_WEB_EXPECT_ENTRY)
    assert.ok(
      await page
        .locator('script[type="module"][src]')
        .evaluateAll(
          (nodes, expected) =>
            nodes.some((node) =>
              new URL(node.src).pathname.endsWith("/" + expected),
            ),
          process.env.RV_WEB_EXPECT_ENTRY,
        ),
      "loads the expected production application entry",
    );
  await page
    .getByRole("checkbox", { name: "Create an account", exact: true })
    .check();
  await page.getByLabel("Invitation code", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel("Invitation code", { exact: true })
      .getAttribute("type"),
    "password",
  );
  await page
    .getByRole("checkbox", { name: "Recover my account", exact: true })
    .check();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Create an account", exact: true })
      .isChecked(),
    false,
  );
  await page.getByLabel("New password", { exact: true }).waitFor();
  await page
    .getByRole("checkbox", { name: "Recover my account", exact: true })
    .uncheck();
  await page.getByLabel("Password", { exact: true }).waitFor();
  console.log(
    "PASS GTK login account modes are exclusive, explain their fields and hide account codes",
  );
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor({ timeout: 45000 });
  await page.locator(".account-avatar").click();
  const activity = page.getByRole("menu");
  await activity.waitFor();
  assert.deepEqual(await activity.getByRole("menuitem").allTextContents(), [
    "Online",
    "Away",
    "Busy",
    "Offline",
  ]);
  assert.deepEqual(
    await activity.locator(".presence").evaluateAll((dots) =>
      dots.map((dot) => {
        const style = getComputedStyle(dot),
          rect = dot.getBoundingClientRect(),
          label = dot.parentElement.parentElement.getBoundingClientRect();
        return {
          color: style.backgroundColor,
          width: rect.width,
          height: rect.height,
          circle: style.borderRadius,
          inside: rect.left >= label.left && rect.right <= label.right,
          decorative: dot.parentElement.getAttribute("aria-hidden"),
        };
      }),
    ),
    [
      "rgb(62, 214, 127)",
      "rgb(255, 194, 75)",
      "rgb(255, 95, 109)",
      "rgb(90, 85, 115)",
    ].map((color) => ({
      color,
      width: 9,
      height: 9,
      circle: "999px",
      inside: true,
      decorative: "true",
    })),
    "all four choices render the GTK green/yellow/red/gray presence circles inside their rows",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-presence-menu-parity.png",
  });
  await page.keyboard.press("Escape");
  await activity.waitFor({ state: "detached" });
  for (const [label, status] of [
    ["Away", "away"],
    ["Online", "online"],
  ]) {
    await page.locator(".account-avatar").click();
    const changed = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === "/api/v1/me",
    );
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    const response = await changed;
    assert.equal(
      response.status(),
      200,
      "choosing a colored status is accepted by the actual server",
    );
    assert.equal(response.request().postDataJSON().status, status);
    await page.locator(".account-avatar .own-presence." + status).waitFor();
    await page.locator(".status-dot.online").waitFor();
  }
  console.log(
    "PASS GTK activity menu renders all four native presence circles and saves the chosen status",
  );
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "New message", exact: true })
    .click();
  const dialog = page.locator(".new-conversation-dialog");
  await dialog.getByLabel("Exact username", { exact: true }).waitFor();
  await dialog.getByLabel("Room name", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".preferences-group").count(), 2);
  assert.equal(
    await dialog
      .getByRole("switch", { name: "Private room", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(await dialog.locator(".tabs").count(), 0);
  await page.screenshot({
    path: "../../.cache/web-shots/web-new-conversation-parity.png",
  });
  const name = "shell-parity-" + crypto.randomUUID().slice(0, 8);
  await dialog.getByLabel("Room name", { exact: true }).fill(name);
  await dialog
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  const row = page.locator(".room-row").filter({ hasText: name });
  await row.waitFor();
  const roomId = await row.getAttribute("data-room");
  const login = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then((response) => response.json());
  const read = () =>
    fetch(base + "/api/v1/rooms/" + roomId + "/read", {
      headers: { Authorization: "Bearer " + login.token },
    }).then((response) => response.json());
  assert.equal((await read()).favorite, false);
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add to favorites", exact: true })
    .waitFor();
  assert.equal(
    (await read()).favorite,
    false,
    "opening the menu does not mutate a favourite",
  );
  await page.keyboard.press("Escape");
  assert.equal((await read()).favorite, false, "dismissing the menu is inert");
  await row.click({ button: "right" });
  const favorite = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/v1/rooms/" + roomId + "/favorite"),
  );
  await page
    .getByRole("menuitem", { name: "Add to favorites", exact: true })
    .click();
  assert.equal((await favorite).status(), 200);
  assert.equal(
    (await read()).favorite,
    true,
    "the explicit mutation is acknowledged before reopening its menu",
  );
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Remove from favorites", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal((await read()).favorite, true);
  console.log(
    "PASS native creation defaults and explicit room menu actions match GTK",
  );
  assert.deepEqual(
    await page.locator(".room-header > button").evaluateAll((nodes) =>
      nodes
        .filter((node) => !node.classList.contains("mobile-back"))
        .map((node) => node.getAttribute("aria-label"))
        .filter(Boolean),
    ),
    ["Pinned and starred", "Search in room", "Join voice"],
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-shell-parity.png",
  });
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.locator(".mobile-back").click();
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  console.log("PASS GTK header order and narrow one-pane back navigation");
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/shell-parity-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
