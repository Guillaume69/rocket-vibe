// Qualify GTK's invitation and custom emoji pages with real disposable mutations.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
const username = process.env.RV_WEB_ADMIN_LAYOUT_USER || "webadminlayout";
const peerName = process.env.RV_WEB_ADMIN_LAYOUT_PEER || "webadminlayoutpeer";
const password = "web-client-disposable-password";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
assert.ok(username.startsWith("webadminlayout"));
assert.ok(peerName.startsWith("webadminlayout"));
async function request(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    value: response.status === 204 ? undefined : await response.json(),
  };
}
const me = await request("/api/v1/auth/login", null, { username, password });
const peer = await request("/api/v1/auth/login", null, {
  username: peerName,
  password,
});
assert.equal(me.status, 200);
assert.equal(peer.status, 200);
const token = me.value.token;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("../../.cache/web-shots", { recursive: true });
const apiResponse = (path, method) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method,
  );
const admin = page.locator(".admin-dialog");
const openAdmin = async () => {
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Server administration", exact: true })
    .click();
  await admin.locator('[data-admin-card="deployment"]').waitFor();
};
let issued, emojiName;
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await openAdmin();
  await admin.getByRole("button", { name: "Invitations", exact: true }).click();
  const invitations = admin.locator(".admin-invitations");
  await invitations
    .locator(".admin-invitation-list .action-row")
    .first()
    .waitFor();
  const create = invitations.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  const style = await create.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    background: getComputedStyle(node).backgroundImage,
  }));
  assert.ok(style.height <= 42, "the native creation action stays compact");
  assert.equal(
    style.background,
    "none",
    "the native action has a solid suggested color",
  );
  const refresh = invitations.getByRole("button", {
    name: "Refresh",
    exact: true,
  });
  const refreshBox = await refresh.boundingBox();
  const listBox = await invitations
    .locator(".admin-invitation-list .preferences-box")
    .boundingBox();
  assert.ok(
    refreshBox.y + refreshBox.height <= listBox.y + 1,
    "Refresh is beside the list header above its rows",
  );
  const created = apiResponse("/api/v1/admin/invitations", "POST");
  await create.click();
  issued = await (await created).json();
  const code = invitations.getByLabel("Invitation code", { exact: true });
  await code.waitFor();
  assert.equal(await code.inputValue(), issued.token);
  assert.equal(await code.getAttribute("readonly"), "");
  const row = invitations.locator(
    '[data-invitation-id="' + issued.invitation.id + '"]',
  );
  await row.waitFor();
  const refreshed = apiResponse("/api/v1/admin/invitations", "GET");
  await refresh.click();
  assert.ok((await refreshed).ok());
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation
    .getByRole("heading", { name: "Revoke", exact: true })
    .waitFor();
  assert.equal(await confirmation.locator(".dialog-header").count(), 0);
  assert.equal(
    await confirmation
      .getByRole("button", { name: "Verify", exact: true })
      .count(),
    0,
  );
  await confirmation
    .getByText(
      "This code will no longer allow account creation. Accounts already created remain active.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await confirmation.screenshot({
    path: "../../.cache/web-shots/web-admin-invitation-revoke-reference.png",
  });
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "detached" });
  const before = await request("/api/v1/admin/invitations", token);
  assert.equal(
    before.value.find((item) => item.id === issued.invitation.id).revoked_at,
    null,
  );
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  const revoked = apiResponse(
    "/api/v1/admin/invitations/" + issued.invitation.id + "/revoke",
    "POST",
  );
  await confirmation
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  assert.ok((await revoked).ok());
  await row.getByText(/Revoked/).waitFor();
  assert.ok(
    (await request("/api/v1/admin/invitations", token)).value.find(
      (item) => item.id === issued.invitation.id,
    ).revoked_at,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-invitations-reference.png",
    mask: [code],
  });
  console.log(
    "PASS native invitation layout, real issuance/refresh, cancellation and confirmed revocation",
  );

  await admin
    .getByRole("button", { name: "Custom emoji", exact: true })
    .click();
  const list = admin.locator(".admin-emoji-list");
  await list.locator(".preferences-box .action-row").first().waitFor();
  assert.equal(await list.locator('input[type="file"]').count(), 0);
  assert.equal(
    await list.locator(".admin-emoji-add .symbolic-icon").count(),
    1,
    "the native list-add glyph appears on the header action",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-emoji-list-reference.png",
  });
  await list.getByRole("button", { name: "Add an emoji", exact: true }).click();
  const form = admin.locator(".admin-emoji-form");
  await form
    .getByLabel("Name (without colons)", { exact: true })
    .fill("Unsent emoji draft");
  assert.equal(
    await form
      .getByRole("button", { name: "Add an emoji", exact: true })
      .isEnabled(),
    false,
  );
  await admin.locator(".subpage-back").click();
  await form.waitFor({ state: "detached" });
  await list.getByRole("button", { name: "Add an emoji", exact: true }).click();
  assert.equal(
    await form
      .getByLabel("Name (without colons)", { exact: true })
      .inputValue(),
    "",
  );
  emojiName = "gtkparity_" + crypto.randomUUID().slice(0, 8);
  await form
    .getByLabel("Name (without colons)", { exact: true })
    .fill(emojiName);
  await form
    .getByLabel("Aliases, separated by commas", { exact: true })
    .fill(emojiName + "_alias");
  const image = form.getByLabel("Choose an image", { exact: true });
  assert.equal(await image.isVisible(), false);
  const chooser = page.waitForEvent("filechooser");
  await form
    .getByRole("button", { name: "Choose an image", exact: true })
    .click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#39e1cf";
    context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await (
    await chooser
  ).setFiles({
    name: "fixture.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await form
    .locator(".admin-emoji-image-row")
    .getByText("fixture.png", { exact: true })
    .waitFor();
  await form.locator("img.admin-emoji-image").waitFor();
  const submit = form.getByRole("button", {
    name: "Add an emoji",
    exact: true,
  });
  assert.equal(await submit.isEnabled(), true);
  const submitStyle = await submit.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    parentWidth: node.parentElement.getBoundingClientRect().width,
    background: getComputedStyle(node).backgroundImage,
  }));
  assert.ok(
    submitStyle.width < submitStyle.parentWidth * 0.8,
    "the native submit is a centered compact pill",
  );
  assert.equal(submitStyle.background, "none");
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-emoji-form-reference.png",
  });
  const saved = apiResponse("/api/v1/admin/emoji/" + emojiName, "PUT");
  await submit.click();
  assert.ok((await saved).ok());
  await form.waitFor({ state: "detached" });
  const emojiRow = list
    .locator(".admin-emoji-row")
    .filter({ hasText: ":" + emojiName + ":" });
  await emojiRow.waitFor();
  await emojiRow.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation
    .getByRole("heading", { name: "Delete the emoji?", exact: true })
    .waitFor();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.ok(
    (await request("/api/v1/emoji", token)).value.items.some(
      (item) => item.name === emojiName,
    ),
  );
  await emojiRow.getByRole("button", { name: "Delete", exact: true }).click();
  const removed = apiResponse("/api/v1/admin/emoji/" + emojiName, "DELETE");
  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  assert.ok((await removed).ok());
  await emojiRow.waitFor({ state: "detached" });
  assert.equal(
    (await request("/api/v1/emoji", token)).value.items.some(
      (item) => item.name === emojiName,
    ),
    false,
  );
  console.log(
    "PASS native emoji list/add navigation, styled image chooser, real creation and cancelled/confirmed deletion",
  );

  const deniedList = await request(
    "/api/v1/admin/invitations",
    peer.value.token,
  );
  const deniedCreate = await request(
    "/api/v1/admin/invitations",
    peer.value.token,
    { operation_id: crypto.randomUUID(), hours: 168, token: "0".repeat(64) },
  );
  assert.equal(deniedList.status, 403);
  assert.equal(deniedCreate.status, 403);
  const deniedEmoji = await fetch(
    base +
      "/api/v1/admin/emoji/" +
      emojiName +
      "_forbidden?operation_id=" +
      crypto.randomUUID(),
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + peer.value.token,
        "Content-Type": "image/png",
      },
      body: Buffer.from(png, "base64"),
    },
  );
  assert.equal(deniedEmoji.status, 403);
  console.log(
    "PASS the real server refuses invitation reads/creation and emoji writes for an ordinary account",
  );

  const peerState = async () =>
    (
      await request(
        "/api/v1/admin/users?q=" + encodeURIComponent(peerName),
        token,
      )
    ).value.items.find((item) => item.id === peer.value.user.id);
  const openPeer = async () => {
    await admin.getByRole("button", { name: "Users", exact: true }).click();
    await admin.getByLabel("Search users", { exact: true }).fill(peerName);
    await admin
      .locator("[data-admin-user]")
      .filter({ hasText: "@" + peerName })
      .click();
    await admin
      .getByRole("button", { name: "Delete account", exact: true })
      .waitFor();
  };
  await openPeer();
  await admin
    .getByRole("button", { name: "Deactivate account", exact: true })
    .click();
  await confirmation
    .getByText("This account will no longer be able to sign in.", {
      exact: true,
    })
    .waitFor();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal((await peerState()).disabled, false);
  await admin
    .getByRole("button", { name: "Delete account", exact: true })
    .click();
  await confirmation
    .getByText(
      "Their messages stay, shown as “Deleted user”. This cannot be undone.",
      { exact: true },
    )
    .waitFor();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.ok(await peerState());
  for (const [action, property, expected] of [
    ["Make administrator", "admin", true],
    ["Remove administrator rights", "admin", false],
  ]) {
    const changed = apiResponse(
      "/api/v1/admin/users/" + peer.value.user.id,
      "PATCH",
    );
    await admin.getByRole("button", { name: action, exact: true }).click();
    assert.ok((await changed).ok());
    assert.equal(
      await page.getByRole("alertdialog").count(),
      0,
      "GTK role changes act directly",
    );
    assert.equal((await peerState())[property], expected);
    await openPeer();
  }
  await admin
    .getByRole("button", { name: "Deactivate account", exact: true })
    .click();
  const disabled = apiResponse(
    "/api/v1/admin/users/" + peer.value.user.id,
    "PATCH",
  );
  await confirmation
    .getByRole("button", { name: "Deactivate account", exact: true })
    .click();
  assert.ok((await disabled).ok());
  assert.equal((await peerState()).disabled, true);
  await openPeer();
  const activated = apiResponse(
    "/api/v1/admin/users/" + peer.value.user.id,
    "PATCH",
  );
  await admin
    .getByRole("button", { name: "Activate account", exact: true })
    .click();
  assert.ok((await activated).ok());
  assert.equal(
    await page.getByRole("alertdialog").count(),
    0,
    "GTK activation acts directly",
  );
  assert.equal((await peerState()).disabled, false);
  console.log(
    "PASS native account delete/deactivate cancellation and direct role/activation actions on the dedicated peer",
  );

  await page.setViewportSize({ width: 900, height: 800 });
  await admin.getByRole("button", { name: "Invitations", exact: true }).click();
  await create.waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-invitations-narrow-reference.png",
    mask: [code],
  });
  await admin.locator(".preferences-close").click();
  await page.evaluate(() => localStorage.setItem("rv-language", "fr"));
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await page
    .getByRole("button", {
      name: "Mon compte, réglages et déconnexion",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Administration du serveur", exact: true })
    .click();
  await admin.getByRole("button", { name: "Invitations", exact: true }).click();
  await admin
    .getByRole("button", { name: "Créer une invitation", exact: true })
    .waitFor();
  await admin.locator(".admin-invitation-list .action-row").first().waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-invitations-fr-reference.png",
  });
  await admin
    .getByRole("button", { name: "Émojis personnalisés", exact: true })
    .click();
  await admin.locator(".admin-emoji-list .action-row").first().waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-emoji-list-fr-reference.png",
  });
  await admin
    .getByRole("button", { name: "Ajouter un émoji", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "Choisir une image", exact: true })
    .waitFor();
  await page.screenshot({
    path: "../../.cache/web-shots/web-admin-emoji-form-fr-reference.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS French and narrow admin layouts retain usable controls without page errors",
  );
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/admin-invitations-failure.png",
    mask: [page.locator(".admin-invitation-code")],
  });
  throw error;
} finally {
  await context.close();
  await browser.close();
  if (issued)
    await request(
      "/api/v1/admin/invitations/" + issued.invitation.id + "/revoke",
      token,
      { operation_id: crypto.randomUUID() },
    ).catch(() => {});
  if (emojiName) {
    const item = (
      await request("/api/v1/emoji", token).catch(() => ({
        value: { items: [] },
      }))
    ).value.items.find((item) => item.name === emojiName);
    if (item)
      await fetch(
        base +
          "/api/v1/admin/emoji/" +
          emojiName +
          "?operation_id=" +
          crypto.randomUUID() +
          "&expected_revision=" +
          encodeURIComponent(item.revision),
        { method: "DELETE", headers: { Authorization: "Bearer " + token } },
      ).catch(() => {});
  }
  const leftover = (
    await request(
      "/api/v1/admin/users?q=" + encodeURIComponent(peerName),
      token,
    ).catch(() => ({ value: { items: [] } }))
  ).value.items.find((item) => item.id === peer.value.user.id);
  if (leftover && (leftover.disabled || leftover.admin))
    await request(
      "/api/v1/admin/users/" + leftover.id,
      token,
      {
        operation_id: crypto.randomUUID(),
        revision: leftover.revision,
        disabled: false,
        admin: false,
      },
      "PATCH",
    ).catch(() => {});
}
