// Qualify GTK's conversation navigation, compact lists and room detail dialogs
// against real permissions, revisions, role changes and message delivery.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { voiceRoomSettings } from "./voice-room-settings.mjs";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_ALICE || "webalice";
const peerName = process.env.RV_WEB_BOB || "webbob";
const password = "web-client-disposable-password";
async function api(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
  attempt = 0,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  if (
    method === "GET" &&
    response.status === 409 &&
    value.code === "delivery_revalidate" &&
    attempt < 5
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return api(path, token, body, method, attempt + 1);
  }
  assert.ok(
    response.ok,
    path + " " + response.status + " " + JSON.stringify(value),
  );
  return value;
}
const me = await api("/api/v1/auth/login", null, { username, password });
const peer = await api("/api/v1/auth/login", null, {
  username: peerName,
  password,
});
const name = "parity-" + crypto.randomUUID().slice(0, 8);
const room = await api("/api/v1/rooms", me.token, {
  name,
  private: false,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + peer.user.id,
  me.token,
  null,
);
const send = (text) =>
  api("/api/v1/rooms/" + room.id + "/messages", peer.token, {
    operation_id: crypto.randomUUID(),
    text,
  });
const first = await send("GTK parity first " + name);
const second = await send("GTK parity continuation " + name);
await api(
  "/api/v1/messages/" + first.id + "/pin",
  me.token,
  { operation_id: crypto.randomUUID(), present: true },
  "PUT",
);
const destination = await api("/api/v1/rooms", me.token, {
  name: name + "-quoted",
  private: false,
  operation_id: crypto.randomUUID(),
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await voiceRoomSettings(page);
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  const row = page.locator(
    '.room-content .timeline [data-id="' + second.id + '"]',
  );
  await row.waitFor();
  assert.ok(
    await row.evaluate((node) => node.classList.contains("grouped")),
    "same author continues the GTK row",
  );
  if (
    Math.floor(Date.parse(first.created_at) / 60000) ===
    Math.floor(Date.parse(second.created_at) / 60000)
  )
    assert.equal(
      await row.locator(".gutter-time").textContent(),
      "",
      "same minute has no repeated gutter time",
    );
  assert.equal(
    await page
      .locator(".room-content .timeline > :first-child")
      .evaluate((node) => node.classList.contains("day-separator")),
    true,
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#toasts > *").length === 0,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-conversation-final-reference.png",
  });
  await row.locator(".row-more").click();
  const actions = page.locator(".actions-menu");
  await actions.locator(".quick-reaction.more-reactions").waitFor();
  assert.equal(
    await actions.locator(".quick-reaction").count(),
    6,
    "GTK offers five quick reactions and its plus button",
  );
  const labels = await actions.locator(".menu-action").allTextContents();
  assert.equal(labels[0], "Copy");
  assert.equal(labels[1], "Copy message link");
  assert.ok(labels.indexOf("Reply") < labels.indexOf("Reply in thread"));
  assert.ok(labels.indexOf("Pin") < labels.indexOf("Star"));
  assert.ok(!labels.includes("React") && !labels.includes("Profile"));
  await page.screenshot({
    path: "../../.cache/web-shots/web-message-actions-reference.png",
  });
  await page.keyboard.press("Escape");
  await row.locator(".row-more").click();
  await page
    .getByRole("button", { name: "Quote in another conversation", exact: true })
    .click();
  const elsewhere = page.locator(".quote-room-picker");
  await elsewhere
    .getByLabel("Search people or channels")
    .fill(destination.name);
  await elsewhere
    .locator(".spotlight-row")
    .getByText(destination.name, { exact: true })
    .click();
  await elsewhere.waitFor({ state: "detached" });
  await page.locator(".room-content .reply-bar").waitFor();
  await page
    .locator(".room-content .rich-composer")
    .fill("Quoted in another room " + name);
  await page.locator(".room-content .rich-composer").press("Enter");
  await page
    .locator(".room-content .timeline .message .message-body")
    .getByText("Quoted in another room " + name, { exact: true })
    .waitFor();
  const delivered = await api(
    "/api/v1/rooms/" + destination.id + "/messages",
    me.token,
  );
  assert.ok(
    delivered.messages.some((message) =>
      message.quotes?.some(
        (quote) =>
          quote.reference.message_id === second.id &&
          quote.reference.room_id === room.id,
      ),
    ),
    "cross-room quoting retains the authorized source reference",
  );
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await row.waitFor();
  const draft = page.locator(".room-content .rich-composer");
  await draft.fill("");
  await page
    .locator(".room-content .composer-pill")
    .getByRole("button", { name: "React", exact: true })
    .click();
  const picker = page.locator(".emoji-picker[popover]");
  await picker.waitFor();
  assert.ok((await picker.locator(".picker-tab").count()) >= 8);
  assert.equal(
    await picker.locator("select").count(),
    0,
    "GTK uses category tabs",
  );
  await picker.locator(".picker-emoji").first().click();
  const one = await draft.evaluate((node) => node.value);
  await picker.locator(".picker-emoji").first().click();
  assert.ok((await draft.evaluate((node) => node.value)).length > one.length);
  assert.equal(
    await picker.isVisible(),
    true,
    "composer picker stays open for repeated choices",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-emoji-picker-reference.png",
  });
  await page.keyboard.press("Escape");
  await draft.fill("Keep this unsent draft");
  await page
    .locator(".room-content")
    .getByRole("button", { name: "Send later", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pick a time", exact: true })
    .click();
  const calendar = page.locator(".time-picker-dialog");
  await calendar.waitFor();
  assert.equal(await calendar.locator(".calendar-day").count(), 42);
  assert.equal(await calendar.locator(".dialog-header").count(), 0);
  assert.ok(await calendar.locator(".calendar-day.other-month").count());
  await calendar.getByLabel("Hour", { exact: true }).fill("24");
  assert.equal(
    await calendar
      .getByRole("button", { name: "Schedule", exact: true })
      .isEnabled(),
    false,
  );
  await calendar.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await draft.evaluate((node) => node.value),
    "Keep this unsent draft",
  );
  assert.equal(
    (await api("/api/v1/scheduled", me.token)).messages.filter(
      (value) => value.room_id === room.id,
    ).length,
    0,
  );
  await draft.fill("");
  console.log(
    "PASS GTK action order, repeated anchored emoji choices and cancelled calendar preserve draft and server state",
  );
  await page
    .locator(".room-header")
    .getByRole("button", { name: "Pinned and starred", exact: true })
    .click();
  const marked = page.locator(".marked-dialog");
  await marked.getByRole("tab", { name: "Pinned", exact: true }).waitFor();
  assert.deepEqual(await marked.getByRole("tab").allTextContents(), [
    "Pinned",
    "My starred",
  ]);
  assert.equal(await marked.locator(".dialog-header h2").count(), 0);
  assert.equal(
    await marked.evaluate((node) =>
      Math.round(node.getBoundingClientRect().height),
    ),
    560,
  );
  await marked.locator('[data-id="' + first.id + '"]').waitFor();
  assert.equal(
    await marked.locator(".tile-message,.row-more,.message-gutter").count(),
    0,
  );
  await marked
    .getByRole("button", { name: "Open message", exact: true })
    .click();
  await marked.waitFor({ state: "detached" });
  await page
    .locator(".room-header")
    .getByRole("button", { name: "Search in room", exact: true })
    .click();
  const search = page.locator(".room-search-dialog");
  await search.getByLabel("Search messages", { exact: true }).fill(name);
  await search.locator(".conversation-preview").first().waitFor();
  assert.equal(await search.locator(".row-more,.tile-message").count(), 0);
  await search.locator(".conversation-preview").first().click();
  await search.waitFor({ state: "detached" });
  console.log(
    "PASS GTK timeline grouping and compact activatable marked/search rows",
  );
  await page.locator(".room-heading").click();
  const info = page.locator(".room-info-dialog");
  await info.getByRole("button", { name: "Edit room", exact: true }).waitFor();
  assert.equal(
    await info
      .locator('input:not([type="file"]),textarea,select,.member-row')
      .count(),
    0,
    "information is a GTK summary",
  );
  assert.deepEqual(
    await info.locator(".dialog-body > button").allTextContents(),
    [
      "Add to favorites",
      "Room encryption",
      "Invite to this room",
      "Edit room",
      "Show members",
      "Leave room",
    ],
  );
  assert.equal(
    await info.evaluate((node) =>
      Math.round(node.getBoundingClientRect().width),
    ),
    420,
  );
  assert.equal(
    await info.evaluate((node) =>
      Math.round(node.getBoundingClientRect().height),
    ),
    600,
  );
  await info
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await info
    .getByRole("button", { name: "Remove from favorites", exact: true })
    .waitFor();
  assert.equal(
    (await api("/api/v1/rooms/" + room.id + "/read", me.token)).favorite,
    true,
  );
  await info
    .getByRole("button", { name: "Invite to this room", exact: true })
    .click();
  const invite = page.locator(".room-invite-dialog");
  await invite
    .getByLabel("Exact username", { exact: true })
    .fill("Unsent invitation");
  assert.equal(await invite.locator(".preferences-group").count(), 1);
  await page.keyboard.press("Escape");
  await invite.waitFor({ state: "detached" });
  assert.equal(
    (await api("/api/v1/rooms/" + room.id + "/members", me.token)).members
      .length,
    2,
  );
  await info.getByRole("button", { name: "Leave room", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Leave room", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await info.isVisible(), true);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#39e1cf";
    context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const avatarSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/rooms/" + room.id + "/avatar" &&
      response.request().method() === "PUT",
  );
  await info
    .getByLabel("Change channel image…", { exact: true })
    .setInputFiles({
      name: "room.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  assert.ok((await avatarSaved).ok());
  await info.locator(".tile-profile .avatar-image").waitFor();
  await page.locator(".room-heading .avatar-image").waitFor();
  await page
    .locator('[data-room="' + room.id + '"] .avatar-image')
    .first()
    .waitFor();
  let lostAvatar;
  const lostAvatarReceipt = Promise.withResolvers();
  const avatarRoute = "**/api/v1/rooms/" + room.id + "/avatar?*";
  await page.route(avatarRoute, async (route) => {
    if (route.request().method() !== "PUT" || lostAvatar)
      return route.continue();
    lostAvatar = new URL(route.request().url());
    try {
      const response = await route.fetch();
      assert.ok(response.ok());
      const receipt = await response.json();
      await route.abort("connectionreset");
      lostAvatarReceipt.resolve(receipt);
    } catch (error) {
      lostAvatarReceipt.reject(error);
    }
  });
  await info
    .getByLabel("Change channel image…", { exact: true })
    .setInputFiles({
      name: "room.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  // The pending control appears when staged, before the intercepted PUT commits.
  const acceptedAvatar = await lostAvatarReceipt.promise;
  assert.equal(
    acceptedAvatar.operation_id,
    lostAvatar.searchParams.get("operation_id"),
  );
  await info
    .locator(".room-avatar-status")
    .filter({ hasText: "Could not change the image." })
    .waitFor();
  await info
    .getByRole("button", { name: "Resume saved request", exact: true })
    .waitFor();
  const committedImage = await api("/api/v1/rooms/" + room.id, me.token);
  assert.equal(
    committedImage.revision,
    acceptedAvatar.applied_revision,
    "the committed snapshot matches the intercepted successful photo receipt",
  );
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await page.locator(".room-heading").click();
  await info
    .getByRole("button", { name: "Resume saved request", exact: true })
    .waitFor();
  const replay = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/rooms/" + room.id + "/avatar" &&
      response.request().method() === "PUT",
  );
  await info
    .getByRole("button", { name: "Resume saved request", exact: true })
    .click();
  const replayResponse = await replay;
  assert.ok(replayResponse.ok());
  assert.equal(
    new URL(replayResponse.url()).searchParams.get("operation_id"),
    lostAvatar.searchParams.get("operation_id"),
  );
  assert.equal(
    (await api("/api/v1/rooms/" + room.id, me.token)).revision,
    committedImage.revision,
    "replaying the retained photo receipt does not repeat its metadata mutation",
  );
  await info
    .locator(".room-avatar-pending button")
    .waitFor({ state: "detached" });
  await page.unroute(avatarRoute);
  await page.screenshot({
    path: "../../.cache/web-shots/web-room-information-reference.png",
  });
  await info.getByRole("button", { name: "Edit room", exact: true }).click();
  const edit = page.locator(".room-settings-dialog");
  assert.equal(
    await edit.locator("textarea").count(),
    3,
    "room text fields are multiline",
  );
  await edit
    .getByLabel("Room name", { exact: true })
    .fill("Discard this room name");
  await page.keyboard.press("Escape");
  await edit.waitFor({ state: "detached" });
  await info.getByRole("button", { name: "Edit room", exact: true }).click();
  assert.equal(
    await edit.getByLabel("Room name", { exact: true }).inputValue(),
    room.name,
  );
  await edit
    .getByLabel("Topic", { exact: true })
    .fill("A *topic* from GTK parity");
  await edit
    .getByLabel("Description", { exact: true })
    .fill("Line one\nLine two");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await edit.waitFor({ state: "detached" });
  await info.getByText("A topic from GTK parity", { exact: true }).waitFor();
  assert.equal(
    await info.locator(".details-text strong").textContent(),
    "topic",
  );
  const updated = await api("/api/v1/rooms/" + room.id, me.token);
  assert.equal(updated.topic, "A *topic* from GTK parity");
  assert.equal(updated.description, "Line one\nLine two");
  await info.getByRole("button", { name: "Show members", exact: true }).click();
  const roster = page.locator(".room-members-dialog");
  assert.equal(
    await roster.getByRole("button", { name: "Delete", exact: true }).count(),
    0,
  );
  await roster
    .getByLabel("Role · " + peerName, { exact: true })
    .selectOption("moderator");
  const roleChange = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/members/" + peer.user.id + "/role",
      ) && response.request().method() === "PUT",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-room-members-reference.png",
  });
  await roster
    .locator(".preferences-group")
    .filter({ has: page.getByLabel("Role · " + peerName, { exact: true }) })
    .getByRole("button", { name: "Apply role", exact: true })
    .click();
  assert.ok((await roleChange).ok(), "role change accepted by the real server");
  const members = await api("/api/v1/rooms/" + room.id + "/members", me.token);
  assert.equal(
    members.members.find((member) => member.user.id === peer.user.id).role,
    "moderator",
  );
  await roster.waitFor({ state: "detached" });
  assert.equal(
    await info.isVisible(),
    true,
    "nested GTK roster returns to information",
  );
  await page.keyboard.press("Escape");
  await info.waitFor({ state: "detached" });
  const dm = await api("/api/v1/direct-messages", me.token, {
    user_id: peer.user.id,
  });
  assert.equal(
    dm.read_state,
    undefined,
    "native creation receipt is deliberately not personalized",
  );
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "New message", exact: true })
    .click();
  const newDm = page.locator(".new-message-dialog");
  await newDm
    .getByLabel("Search people or channels", { exact: true })
    .fill(peerName);
  await newDm.locator('[data-user="' + peer.user.id + '"]').click();
  await newDm.waitFor({ state: "detached" });
  await page.waitForURL("**/room/" + dm.id);
  await page.locator(".room-heading").click();
  await page
    .locator(".user-profile-dialog")
    .getByRole("heading", {
      name: peer.user.display_name || peerName,
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator(".room-info-dialog").count(), 0);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("rv-profile-update")),
  );
  assert.equal(
    await page.locator(".user-profile-dialog").isVisible(),
    true,
    "personalization preserves the DM membership fence when profile updates arrive",
  );
  const roles = await api("/api/v1/rooms/" + room.id + "/members", me.token);
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + peer.user.id + "/role",
    me.token,
    {
      operation_id: crypto.randomUUID(),
      expected_revision: roles.revision,
      role: "member",
    },
    "PUT",
  );
  const memberPage = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  memberPage.on("pageerror", (error) => errors.push(error.message));
  await memberPage.goto(base);
  await memberPage.getByLabel("Username or email").fill(peerName);
  await memberPage.getByLabel("Password", { exact: true }).fill(password);
  await memberPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await memberPage.locator(".status-dot.online").waitFor();
  await memberPage
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await memberPage.locator(".room-heading").click();
  const memberInfo = memberPage.locator(".room-info-dialog");
  await memberInfo
    .getByRole("button", { name: "Show members", exact: true })
    .waitFor();
  assert.deepEqual(
    await memberInfo.locator(".dialog-body > button").allTextContents(),
    ["Add to favorites", "Room encryption", "Show members", "Leave room"],
  );
  assert.equal(await memberInfo.locator(".room-avatar-controls").count(), 0);
  await memberPage.screenshot({
    path: "../../.cache/web-shots/web-room-information-member-reference.png",
  });
  await memberInfo
    .getByRole("button", { name: "Show members", exact: true })
    .click();
  const memberRoster = memberPage.locator(".room-members-dialog");
  await memberRoster.locator("select").first().waitFor();
  assert.equal(await memberRoster.locator("select:enabled").count(), 0);
  assert.equal(
    await memberRoster
      .getByRole("button", { name: "Apply role", exact: true })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.locator(".room-heading").click();
  await page.route(avatarRoute, (route) =>
    route.request().method() === "PUT"
      ? route.abort("connectionreset")
      : route.continue(),
  );
  await info
    .getByLabel("Change channel image…", { exact: true })
    .setInputFiles({
      name: "room.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  await info
    .getByRole("button", { name: "Resume saved request", exact: true })
    .waitFor();
  const beforeWithdrawal = await api(
    "/api/v1/rooms/" + room.id + "/members",
    me.token,
  );
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + peer.user.id + "/role",
    me.token,
    {
      operation_id: crypto.randomUUID(),
      expected_revision: beforeWithdrawal.revision,
      role: "owner",
    },
    "PUT",
  );
  const removal = await api(
    "/api/v1/rooms/" + room.id + "/members",
    peer.token,
  );
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + me.user.id,
    peer.token,
    { operation_id: crypto.randomUUID(), expected_revision: removal.revision },
    "DELETE",
  );
  await info.waitFor({ state: "detached" });
  await page.waitForFunction(async (roomId) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("rocket-vibe-web");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return new Promise((resolve, reject) => {
      const read = db
        .transaction("operations")
        .objectStore("operations")
        .getAll();
      read.onsuccess = () =>
        resolve(!read.result.some((value) => value?.room === roomId));
      read.onerror = () => reject(read.error);
    });
  }, room.id);
  await page.unroute(avatarRoute);
  assert.deepEqual(errors, []);
  console.log(
    "PASS separate GTK room information, editing and members with real revisioned writes",
  );
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/conversation-parity-failure.png",
  });
  console.error(await page.locator("#toasts").textContent());
  throw error;
} finally {
  await browser.close();
}
