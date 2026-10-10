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
let releaseFixture = [];
await page.route(
  "https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=50",
  (route) => {
    assert.equal(route.request().headers().authorization, undefined);
    assert.equal(route.request().headers().referer, undefined);
    return route.fulfill({ json: releaseFixture });
  },
);
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
  // One icon: the gear saying the block opens the account menu.
  assert.equal(await page.locator(".account .symbolic-icon").count(), 1);
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.locator(".settings-dialog");
  await settings.locator("[data-category=app]").waitFor();
  const expected = [
    "My account",
    "Notifications",
    "Language",
    "Voice",
    "Encryption",
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
  const overviewResult = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/admin/overview",
  );
  await settings
    .getByRole("button", { name: "Server administration", exact: true })
    .click();
  const admin = page.locator(".admin-dialog");
  const overview = await (await overviewResult).json();
  await admin.locator('[data-admin-card="deployment"]').waitFor();
  assert.equal(
    await admin.locator(".preferences-sidebar h2").textContent(),
    "Server administration",
  );
  const card = (id) => admin.locator('[data-admin-card="' + id + '"]');
  const row = (id, name) =>
    card(id)
      .locator(".action-row")
      .filter({ has: page.getByText(name, { exact: true }) });
  const value = (id, name) =>
    row(id, name).locator(".admin-value").textContent();
  assert.equal(await value("deployment", "Version"), overview.server_version);
  assert.equal(
    await value("deployment", "Database"),
    "PostgreSQL " + overview.postgres_version,
  );
  if (overview.migration_version)
    assert.equal(
      await value("deployment", "Migration"),
      overview.migration_version,
    );
  assert.equal(
    await row("deployment", "Instance")
      .locator(".admin-value")
      .getAttribute("title"),
    overview.instance_id,
  );
  assert.equal(
    await card("deployment")
      .getByRole("button", { name: "Copy", exact: true })
      .count(),
    1,
  );
  assert.deepEqual(
    await card("users").locator(".action-row-title").allTextContents(),
    [
      "Total",
      "Active",
      "Deactivated",
      "Administrators",
      "Online",
      "Away",
      "Busy",
      "Offline",
    ],
  );
  for (const [name, key] of [
    ["Online", "online"],
    ["Away", "away"],
    ["Busy", "busy"],
    ["Offline", "offline"],
  ]) {
    assert.equal(await value("users", name), String(overview.users[key]));
    assert.equal(await row("users", name).locator(".presence").count(), 1);
  }
  for (const id of ["rooms", "messages"]) {
    assert.deepEqual(
      await card(id).locator(".action-row-title").allTextContents(),
      ["Total", "Public", "Private", "Direct messages", "Encrypted"],
    );
    assert.equal(await value(id, "Encrypted"), String(overview[id].encrypted));
  }
  const refresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/admin/overview",
  );
  await card("deployment")
    .getByRole("button", { name: "Compute the figures again", exact: true })
    .click();
  assert.ok((await refresh).ok());
  await card("deployment").waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-dashboard-native-reference.png",
  });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-dashboard-narrow-reference.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await card("reports")
    .getByRole("button", { name: "Open moderation", exact: true })
    .click();
  assert.equal(
    await admin.locator(".preferences-content h2").textContent(),
    "Moderation",
  );
  console.log(
    "PASS the GTK dashboard's actual deployment, four presences, kind counts, refresh and moderation navigation",
  );
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
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.locator(".settings-dialog .preferences-sidebar-close").click();
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator(".settings-dialog").count(), 0);
  console.log("PASS narrow settings can close from the category pane");
  releaseFixture = [
    { tag_name: "desktop-v99.0.0" },
    { tag_name: "server-v0.1.5" },
    { tag_name: "server-v0.3.0" },
    { tag_name: "server-v0.1.9" },
    { tag_name: "server-v9.0.0", draft: true },
    { tag_name: "server-v8.0.0", prerelease: true },
    { tag_name: "server-v7.0.0-rc.1" },
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.setItem("rv-language", "fr"));
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "Mon compte, réglages et déconnexion",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Paramètres", exact: true }).click();
  await page
    .locator(".settings-dialog")
    .getByRole("button", { name: "Administration du serveur", exact: true })
    .click();
  await admin.locator(".admin-update.available").waitFor();
  assert.match(
    await admin.locator(".admin-update.available").textContent(),
    /0\.3\.0$/,
  );
  assert.equal(
    await admin.locator(".preferences-sidebar h2").textContent(),
    "Administration du serveur",
  );
  assert.equal(await card("users").locator("h3").textContent(), "Utilisateurs");
  assert.equal(
    await card("deployment").getByText("Lancé depuis", { exact: true }).count(),
    1,
  );
  console.log(
    "PASS GTK French admin labels and the highest published server release without authenticated headers",
  );
  const policy = card("bots").getByRole("switch");
  const originalPolicy = await policy.isChecked();
  await page.route("**/api/v1/admin/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 403, json: { code: "permission_denied" } })
      : route.continue(),
  );
  await policy.click();
  await page.waitForFunction((checked) => {
    const input = document.querySelector('[data-admin-card="bots"] input');
    return input && !input.disabled && input.checked === checked;
  }, originalPolicy);
  await page.unroute("**/api/v1/admin/settings");
  console.log(
    "PASS a refused bot policy change restores the authoritative switch without changing the server",
  );
  const catalog = JSON.parse(
    await readFile("src/native-strings.generated.json", "utf8"),
  );
  const refusal = page
    .locator("#toasts")
    .getByText(catalog["admin.error_denied"][0], { exact: true });
  await refusal.waitFor();
  await refusal.waitFor({ state: "detached" });
  releaseFixture = [];
  await admin.locator(".preferences-close").click();
  // The account block opens a menu: settings, administration, sign out.
  await page
    .getByRole("button", {
      name: "Mon compte, réglages et déconnexion",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Paramètres", exact: true }).click();
  await page
    .locator(".settings-dialog")
    .getByRole("button", { name: "Administration du serveur", exact: true })
    .click();
  await card("deployment").waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-dashboard-fr-reference.png",
  });
  await admin
    .locator(".preferences-scroll")
    .evaluate((node) => (node.scrollTop = node.scrollHeight));
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-dashboard-fr-lower-reference.png",
  });
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
