import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { base, fixture } from "./crypto-browser.mjs";

export async function voiceRoomSettings(page) {
  const discovery = await page.evaluate(() =>
    fetch("/.well-known/rocketvibe").then((response) => response.json()),
  );
  if (!discovery.capabilities.voice) return;
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Create a channel", exact: true })
    .click();
  const create = page.locator(".new-conversation-dialog"),
    name = "voice-settings-" + crypto.randomUUID().slice(0, 8);
  await create.getByLabel("Room name", { exact: true }).fill(name);
  assert.equal(
    await create
      .getByRole("switch", { name: "Voice channel", exact: true })
      .isChecked(),
    false,
  );
  await create
    .getByRole("switch", { name: "Voice channel", exact: true })
    .check();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/rooms"),
  );
  await create
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  const response = await created;
  assert.equal(response.status(), 200);
  const room = await response.json();
  assert.equal(room.voice, true);
  assert.equal(room.kind, "private");
  await create.waitFor({ state: "detached" });
  const row = page.locator('[data-room="' + room.id + '"]');
  await row.locator(".room-top .symbolic-icon").waitFor();
  const voicePage = page.locator(".voice-page");
  await voicePage.locator(".voice-status.connected").waitFor();
  await voicePage
    .getByRole("button", { name: "Open the chat", exact: true })
    .click();
  await page.locator(".room-heading").filter({ hasText: name }).click();
  const info = page.locator(".room-info-dialog"),
    editor = page.locator(".room-settings-dialog"),
    updates = [];
  const record = (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith("/api/v1/rooms/" + room.id)
    )
      updates.push(JSON.parse(request.postData()).voice);
  };
  page.on("request", record);
  try {
    await info.getByRole("button", { name: "Edit room", exact: true }).click();
    const voice = editor.getByRole("switch", { name: /^Voice channel/ });
    assert.equal(await voice.isChecked(), true);
    await voice.uncheck();
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    assert.equal((await fixture(page, "/api/v1/rooms/" + room.id)).voice, true);
    assert.deepEqual(updates, [], "cancel never submits its switch value");
    for (const enabled of [false, true]) {
      const before = await fixture(page, "/api/v1/rooms/" + room.id);
      await info
        .getByRole("button", { name: "Edit room", exact: true })
        .click();
      assert.equal(
        await voice.isChecked(),
        before.voice,
        "reopening restores the saved switch",
      );
      await voice.setChecked(enabled);
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().endsWith("/api/v1/rooms/" + room.id),
      );
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      assert.equal((await saved).status(), 200);
      await editor.waitFor({ state: "detached" });
      await info
        .getByRole("button", { name: "Edit room", exact: true })
        .waitFor();
      const after = await fixture(page, "/api/v1/rooms/" + room.id);
      assert.equal(after.voice, enabled);
      assert.equal(!!after.room.voice, enabled);
      assert.notEqual(after.revision, before.revision);
      assert.notEqual(after.room.revision, before.room.revision);
      await page.waitForFunction(
        ({ id, enabled }) =>
          document.querySelectorAll(
            '[data-room="' + id + '"] .room-top .symbolic-icon',
          ).length === Number(enabled),
        { id: room.id, enabled },
      );
    }
    assert.deepEqual(updates, [false, true]);
    await info.locator(".dialog-header button").click();
    const leave = page
      .locator(".voice-bar")
      .getByRole("button", { name: "Close", exact: true });
    if (await leave.isVisible()) {
      await leave.click();
      await page.locator(".voice-bar").waitFor({ state: "detached" });
    }
    console.log(
      "PASS native voice-room creation, cancelled settings and revisioned voice disable/enable",
    );
  } finally {
    page.off("request", record);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  try {
    const page = await browser.newPage({ locale: "en-US" }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page
      .getByLabel("Username or email")
      .fill(process.env.RV_WEB_VOICE_CREATION_USER || "webvoicecreationgtk");
    await page
      .getByLabel("Password", { exact: true })
      .fill("web-client-disposable-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".status-dot.online").waitFor();
    await voiceRoomSettings(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
