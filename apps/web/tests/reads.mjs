import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const password = "web-client-disposable-password";
async function api(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.ok(
    response.ok,
    method + " " + path + " " + response.status + " " + JSON.stringify(data),
  );
  return data;
}
const names = [
  process.env.RV_WEB_READ_USER || "webread",
  process.env.RV_WEB_READ_PEER || "webreadpeer",
  process.env.RV_WEB_READ_OWNER || "webreadowner",
];
const accounts = [];
for (const username of names)
  accounts.push(
    await api("/api/v1/auth/login", undefined, { username, password }),
  );
const [reader, peer, owner] = accounts;
const tag = crypto.randomUUID().slice(0, 8);
const room = await api("/api/v1/rooms", reader.token, {
  name: "read-" + tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
for (const member of [peer, owner])
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + member.user.id,
    reader.token,
    null,
  );
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
await context.addInitScript(() => {
  // Headless Chromium keeps every tab visible even after bringToFront. Inject
  // only visibility events; message delivery and server read state stay real.
  window.__inactive = false;
  Object.defineProperty(document, "hidden", { get: () => window.__inactive });
  window.__setInactive = (inactive) => {
    window.__inactive = inactive;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  window.__notes = [];
  window.Notification = class {
    static permission = "granted";
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      window.__notes.push(this);
    }
    close() {
      this.closed = true;
    }
  };
});
const page = await context.newPage();
const readRequests = [];
page.on("request", (request) => {
  if (
    request.method() === "POST" &&
    /\/rooms\/[^/]+\/read$/.test(request.url())
  )
    readRequests.push({
      at: Date.now(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
    });
});
let bot, workflow;
const state = (id = room.id) =>
  api("/api/v1/rooms/" + id + "/read", reader.token);
async function readThrough(message, id = room.id) {
  for (let tries = 0; tries < 70; tries++) {
    const current = await state(id);
    if (
      BigInt(current.root_position) >= BigInt(message.position) &&
      current.unread_roots === "0"
    )
      return;
    await page.waitForTimeout(100);
  }
  const view = await page
    .locator(".room-content > .timeline")
    .evaluate((node) => ({
      focused: document.hasFocus(),
      hidden: document.hidden,
      active:
        document.activeElement?.className || document.activeElement?.tagName,
      height: node.clientHeight,
      bottom: node.scrollHeight - node.scrollTop - node.clientHeight,
    }));
  assert.fail(
    "The visible incoming message must become read without a scroll or navigation: " +
      JSON.stringify({
        view,
        state: await state(id),
        position: message.position,
      }),
  );
}
const send = (text, id = room.id) =>
  api("/api/v1/rooms/" + id + "/messages", peer.token, {
    operation_id: crypto.randomUUID(),
    text,
  });
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(names[0]);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.waitForTimeout(1800);
  const first = await send("An incoming message that fits on screen");
  await page.locator('[data-id="' + first.id + '"]').waitFor();
  assert.equal(
    await page
      .locator(".room-content > .timeline")
      .evaluate((node) => node.scrollHeight <= node.clientHeight),
    true,
  );
  await readThrough(first);
  await page
    .locator('[data-room="' + room.id + '"] .badge-unread')
    .waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__notes.length), 0);
  console.log(
    "PASS a visible incoming message on a short timeline becomes read without any scroll",
  );

  bot = await api("/api/v1/bots", owner.token, {
    operation_id: crypto.randomUUID(),
    username: "readbot" + tag,
    display_name: "Read bot",
    scopes: ["rooms:read", "messages:write"],
  });
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + bot.user.id,
    reader.token,
    null,
  );
  workflow = await api("/api/v1/workflows", owner.token, {
    operation_id: crypto.randomUUID(),
    name: "Read workflow " + tag,
    bot_id: bot.user.id,
    trigger: { kind: "command", name: "read" + tag },
    steps: [
      {
        kind: "message",
        room: "trigger",
        text: "Workflow message observed on screen",
      },
    ],
    enabled: true,
  });
  await page.locator(".composer-input").fill("/read" + tag);
  const commandResult = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/commands/run"),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.ok((await commandResult).ok(), "The real workflow command must run");
  const row = page.locator(".message").filter({
    has: page.getByText("Workflow message observed on screen", {
      exact: true,
    }),
  });
  await row.waitFor();
  const botId = await row.getAttribute("data-id");
  const messages = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    reader.token,
  );
  const posted = messages.messages.find((message) => message.id === botId);
  assert.equal(posted.author.bot, true);
  await readThrough(posted);
  assert.equal(await row.locator(".bot-badge").count(), 1);
  assert.equal(await page.evaluate(() => window.__notes.length), 0);
  console.log(
    "PASS a real command workflow's BOT message is read while its channel is already open",
  );

  // The account block opens a menu: settings, administration, sign out.

  await page.getByRole("button", { name: "My account, settings and sign out", exact: true }).click();

  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.locator(".settings-dialog").waitFor();
  const behind = await send("A message behind the open settings dialog");
  await page.locator('[data-id="' + behind.id + '"]').waitFor();
  await page.waitForTimeout(2000);
  assert.ok(BigInt((await state()).root_position) < BigInt(behind.position));
  await page.locator(".preferences-close").click();
  await page.locator(".composer-input").click();
  await readThrough(behind);
  console.log(
    "PASS an open settings dialog prevents reading the chat behind it",
  );

  const background = await context.newPage();
  await background.goto("about:blank");
  await background.bringToFront();
  await page.evaluate(() => window.__setInactive(true));
  await page.waitForFunction(() => document.hidden || !document.hasFocus());
  const absent = await send(
    "@" + names[0] + " Arrived while the tab was inactive",
  );
  await page.locator('[data-id="' + absent.id + '"]').waitFor();
  await page.waitForTimeout(2000);
  assert.ok(BigInt((await state()).root_position) < BigInt(absent.position));
  await page.locator('[data-room="' + room.id + '"] .badge-unread').waitFor();
  await page.waitForFunction(() => window.__notes.some((note) => !note.closed));
  await page.bringToFront();
  await page.evaluate(() => window.__setInactive(false));
  await page.locator(".composer-input").click();
  await readThrough(absent);
  await page.waitForFunction(() => window.__notes.every((note) => note.closed));
  console.log(
    "PASS inactive visibility events keep messages unread and returning to the chat reads and dismisses its notification",
  );

  const other = await api("/api/v1/rooms", reader.token, {
    name: "read-away-" + tag,
    private: false,
    operation_id: crypto.randomUUID(),
  });
  await api(
    "/api/v1/rooms/" + other.id + "/members/" + peer.user.id,
    reader.token,
    null,
  );
  await page
    .locator('[data-room="' + other.id + '"]')
    .first()
    .click();
  await page.waitForTimeout(1800);
  const away = await send("Leave before the delayed read", other.id);
  await page.locator('[data-id="' + away.id + '"]').waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.waitForTimeout(2000);
  assert.ok(
    BigInt((await state(other.id)).root_position) < BigInt(away.position),
  );
  console.log(
    "PASS switching channels cancels the previous channel's pending read",
  );

  await background.bringToFront();
  await page.evaluate(() => window.__setInactive(true));
  for (let index = 0; index < 12; index++)
    await send(
      "Earlier history " + index + "\n" + "A line of chat\n".repeat(7),
    );
  await page.waitForTimeout(1000);
  await page.bringToFront();
  await page.evaluate(() => window.__setInactive(false));
  await page.locator(".room-content > .timeline").evaluate((node) => {
    node.scrollTop = 0;
  });
  const before = (await state()).root_position;
  const below = await send(
    "@" + names[0] + " A new message below the history being read",
  );
  await page.locator('[data-id="' + below.id + '"]').waitFor();
  await page.waitForTimeout(2000);
  assert.equal((await state()).root_position, before);
  await page.locator(".room-content > .timeline").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await readThrough(below);
  console.log(
    "PASS reading earlier history keeps unseen arrivals unread until returning to the latest messages",
  );
  assert.ok(readRequests.length > 0, "Actual read requests must be sent");
} catch (error) {
  await mkdir("../../.cache/web-shots", { recursive: true });
  await page.screenshot({
    path: "../../.cache/web-shots/web-reads-failed.png",
  });
  throw error;
} finally {
  await browser.close();
  if (workflow)
    await api(
      "/api/v1/workflows/" + workflow.id,
      owner.token,
      undefined,
      "DELETE",
    );
  if (bot)
    await api("/api/v1/bots/" + bot.user.id, owner.token, undefined, "DELETE");
}
