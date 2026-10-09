import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_VISUAL_USER || "webvisual";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await context.newPage();
const errors = [];
const network = [];
page.on("response", (response) => {
  if (new URL(response.url()).pathname.startsWith("/api/"))
    network.push(
      response.request().method() +
        " " +
        new URL(response.url()).pathname +
        " " +
        response.status(),
    );
});
page.on("requestfailed", (request) =>
  network.push(
    new URL(request.url()).pathname + " " + request.failure()?.errorText,
  ),
);
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  await page.goto(base);
  const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
  const response = await fetch(new URL(favicon, base));
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(
      "../desktop/data/icons/hicolor/64x64/apps/com.rocketvibe.app.png",
    ),
  );
  console.log("PASS favicon is the original GTK unicorn image");
  await page.getByLabel("Username or email").fill(username);
  await page
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor({ timeout: 45000 });
  assert.equal(await page.locator(".account .symbolic-icon").count(), 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".settings-dialog");
  await settings.locator("[data-category=app]").waitFor();
  const expected = [
    "My account",
    "Notifications",
    "Language",
    "Voice",
    "Security",
    "Devices",
    "Bots",
    "Workflows",
    "App",
  ];
  assert.deepEqual(
    await settings.locator(".sidebar-categories .category").allTextContents(),
    expected,
  );
  assert.equal(
    await settings.locator(".sidebar-categories .symbolic-icon").count(),
    expected.length,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-settings-reference.png",
  });
  await settings.getByRole("button", { name: "Voice", exact: true }).click();
  const noise = settings.getByRole("switch", {
    name: "Noise suppression",
    exact: true,
  });
  await noise.waitFor();
  assert.equal(await settings.getByRole("switch").count(), 2);
  assert.equal(
    await settings
      .getByLabel("Include the call in a shared screen's sound", {
        exact: true,
      })
      .isChecked(),
    false,
  );
  assert.equal(
    await noise.evaluate((node) => getComputedStyle(node).appearance),
    "none",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-voice-settings-reference.png",
  });
  console.log(
    "PASS voice preferences use GTK device rows, noise and include-call switches without browser stock controls",
  );
  await settings.getByRole("button", { name: "Language", exact: true }).click();
  assert.deepEqual(
    await settings
      .locator("select option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["auto", "fr", "en"],
  );
  await settings.getByRole("button", { name: "App", exact: true }).click();
  assert.equal(
    await settings.getByText("Text size", { exact: true }).count(),
    0,
  );
  assert.equal(
    await settings.getByText("24-hour clock", { exact: true }).count(),
    0,
  );
  assert.equal(
    await settings.getByText("Licenses", { exact: true }).count(),
    0,
  );
  console.log(
    "PASS GTK category order, icons and language choices; invented display options absent",
  );
  await settings
    .getByRole("button", { name: "My account", exact: true })
    .click();
  await settings.getByRole("button", { name: /My profile/ }).click();
  assert.equal(await settings.getByLabel("Profile photo").isVisible(), false);
  await settings
    .getByRole("button", { name: "Change photo", exact: true })
    .waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-profile-reference.png",
  });
  console.log("PASS styled photo action replaces the exposed file input");
  await settings.getByRole("button", { name: "Devices", exact: true }).click();
  const current = settings
    .locator(".device-expander")
    .filter({ hasText: "This device" })
    .first();
  await current.locator("summary").click();
  await current.getByLabel("Name", { exact: true }).fill("GTK parity browser");
  await current.getByRole("button", { name: "Save", exact: true }).click();
  await current
    .locator("summary")
    .getByText("GTK parity browser", { exact: true })
    .waitFor();
  assert.ok(await current.getByText("Expires", { exact: true }).count());
  await page.screenshot({
    path: "../../.cache/web-shots/web-devices-reference.png",
  });
  console.log("PASS native device details and real server-backed rename");
  await settings
    .getByRole("button", { name: "Server administration", exact: true })
    .click();
  const admin = page.locator(".admin-dialog");
  await admin.getByRole("button", { name: "Users", exact: true }).click();
  await admin.locator("[data-admin-user]").first().waitFor();
  assert.ok(
    (
      await admin
        .locator("[data-admin-user] .tile")
        .evaluateAll((tiles) =>
          tiles.map((tile) => tile.getBoundingClientRect().width),
        )
    ).every((width) => width <= 36),
  );
  assert.equal(
    await admin
      .getByRole("button", { name: "Deactivate", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-reference.png",
  });
  console.log(
    "PASS bounded GTK avatars and person actions inside their detail page",
  );
  await admin.locator(".preferences-close").click();
  await page.setViewportSize({ width: 540, height: 800 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-dialog .preferences-sidebar-close").click();
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator(".settings-dialog").count(), 0);
  console.log("PASS narrow settings can close from the category pane");
  assert.deepEqual(errors, []);
} catch (error) {
  console.log("Visual network:", network.slice(-25));
  console.log("Visual UI:", await page.locator(".toast").allTextContents());
  await page.screenshot({ path: "../../.cache/web-shots/visual-failure.png" });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
