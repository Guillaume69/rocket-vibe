import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const session = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "webrail",
      password: "web-client-disposable-password",
    }),
  }).then((r) => r.json());
  const api = async (status, text) => {
    const own = await fetch(base + "/api/v1/me/profile", {
      headers: { Authorization: "Bearer " + session.token },
    }).then((r) => r.json());
    if (status) {
      const result = await fetch(base + "/api/v1/me", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + session.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation_id: crypto.randomUUID(),
          expected_revision: own.profile.revision,
          username: own.profile.user.username,
          display_name: own.profile.user.display_name,
          bio: own.profile.bio,
          status,
          status_text: text ?? own.profile.status_text,
        }),
      });
      assert.equal(result.ok, true);
      return api();
    }
    return own;
  };
  await api("online", "Keep this activity message");
  await page.goto(base);
  await page.getByLabel("Username or email").fill("webrail");
  await page
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".account-avatar").waitFor();
  assert.equal(await page.locator(".sidebar-header .status-dot").count(), 0);
  assert.equal(await page.locator(".account .status-dot").count(), 1);
  for (const status of ["away", "busy", "offline", "online"]) {
    await page.locator(".account-avatar").click();
    const menu = await page.locator(".actions-menu:visible").boundingBox();
    const anchor = await page.locator(".account-avatar").boundingBox();
    assert.ok(
      menu.y + menu.height <= anchor.y && anchor.y - menu.y - menu.height < 12,
      "activity menu is anchored above avatar",
    );
    await page
      .getByRole("menuitem", {
        name: status[0].toUpperCase() + status.slice(1),
        exact: true,
      })
      .click();
    await page.locator(".own-presence." + status).waitFor();
    const own = await api();
    assert.equal(own.profile.status, status);
    assert.equal(own.profile.status_text, "Keep this activity message");
  }
  await page.locator(".account-avatar").click();
  await page.mouse.click(1000, 200);
  assert.equal(await page.locator(".actions-menu:visible").count(), 0);
  await page.locator(".account-controls").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).waitFor();
  await page.mouse.click(1000, 200);
  await api("busy");
  await page.locator(".own-presence.busy").waitFor();
  await mkdir("../../artifacts/rail-presence", { recursive: true });
  await page.screenshot({ path: "../../artifacts/rail-presence/web-wide.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator(".account-avatar").click();
  await page.getByRole("menuitem", { name: "Away", exact: true }).waitFor();
  await page.screenshot({
    path: "../../artifacts/rail-presence/web-narrow.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS avatar: four statuses, preserved status text, remote status refresh, menu dismissal, account menu, connection placement and narrow layout",
  );
} catch (error) {
  await mkdir("../../artifacts/rail-presence", { recursive: true });
  await page.screenshot({
    path: "../../artifacts/rail-presence/web-error.png",
  });
  throw error;
} finally {
  await browser.close();
}
