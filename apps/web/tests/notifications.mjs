// Message notifications through the service worker: the options passed to
// `showNotification` (author's photo and message picture as data URLs, the
// buttons, silent with the app's own sound, no token anywhere), then the
// worker's click path, driven by a dispatched `notificationclick` because a
// real click on a system notification is out of Playwright's reach: Like,
// an inline reply and Mark as read must reach the server with the tab's
// session, a plain click must open the room with the composer focused.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const password = "web-client-disposable-password";
const names = [
  process.env.RV_WEB_NOTIFY_USER || "webnotify",
  process.env.RV_WEB_NOTIFY_PEER || "webnotifypeer",
];
async function api(path, token, body, method, type) {
  method ??= body === undefined ? "GET" : "POST";
  const raw = body instanceof Uint8Array;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined
        ? {}
        : { "Content-Type": type || "application/json" }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  assert.ok(
    response.ok,
    method + " " + path + " " + response.status + " " + text,
  );
  return data;
}
const accounts = [];
for (const username of names)
  accounts.push(
    await api("/api/v1/auth/login", undefined, { username, password }),
  );
const [receiver, sender] = accounts;
const tag = crypto.randomUUID().slice(0, 8);
const room = await api("/api/v1/rooms", receiver.token, {
  name: "notify-" + tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + sender.user.id,
  receiver.token,
  null,
);

// The full Chromium in new headless mode: the headless shell denies notifications.
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
await context.grantPermissions(["notifications"], { origin: base });
// Two PNGs drawn by the browser: the sender's photo and the posted picture.
const drawing = await context.newPage();
const [photo, picture] = await drawing.evaluate(() =>
  [
    [96, 96, "#e5a50a"],
    [640, 320, "#3584e4"],
  ].map(([width, height, colour]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = colour;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1];
  }),
);
await drawing.close();
const own = await api("/api/v1/me/profile", sender.token);
await api(
  "/api/v1/me/avatar?operation_id=" +
    crypto.randomUUID() +
    "&expected_revision=" +
    encodeURIComponent(own.profile.revision),
  sender.token,
  new Uint8Array(Buffer.from(photo, "base64")),
  "PUT",
  "image/png",
);
await context.addInitScript(() => {
  window.__shown = [];
  window.__constructed = [];
  window.__played = [];
  const show = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (
    title,
    options,
  ) {
    window.__shown.push({ title, options: structuredClone(options) });
    return show.call(this, title, options);
  };
  const Original = window.Notification;
  window.Notification = class extends Original {
    constructor(title, options) {
      super(title, options);
      window.__constructed.push({ title, options });
    }
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__played.push(this.src);
    return play.call(this);
  };
});
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
const reads = () => api("/api/v1/rooms/" + room.id + "/read", receiver.token);
const messages = async () =>
  (await api("/api/v1/rooms/" + room.id + "/messages", receiver.token))
    .messages;
async function until(check, what) {
  for (let tries = 0; tries < 100; tries++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Timed out waiting for " + what);
}
// The worker's own handler, with the notification it posted when the
// browser keeps it (else one carrying the same data).
async function click(data, action, reply = null) {
  const worker = context.serviceWorkers()[0];
  return worker.evaluate(
    async ({ data, action, reply }) => {
      const list = await self.registration.getNotifications();
      const notification = list.find(
        (note) => note.data?.message === data.message,
      );
      const event = new ExtendableEvent("notificationclick");
      Object.defineProperties(event, {
        notification: {
          value: notification || { data, close() {} },
        },
        action: { value: action },
        reply: { value: reply },
      });
      self.dispatchEvent(event);
      return list.length;
    },
    { data, action, reply },
  );
}
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(names[0]);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
    timeout: 20000,
  });
  assert.equal(await page.evaluate(() => Notification.permission), "granted");
  const maxActions = await page.evaluate(() => Notification.maxActions);
  console.log("Notification.maxActions in this Chromium:", maxActions);

  // A mention with a picture, from the sender, while no room is open.
  const bytes = new Uint8Array(Buffer.from(picture, "base64"));
  const slot = await api("/api/v1/uploads", sender.token, {
    operation_id: crypto.randomUUID(),
    room_id: room.id,
    bytes: String(bytes.length),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type: "image/png",
    filename: "blue.png",
    encrypted: false,
  });
  await api(
    "/api/v1/uploads/" + slot.id + "/bytes",
    sender.token,
    bytes,
    "PUT",
    "image/png",
  );
  const posted = await api(
    "/api/v1/uploads/" + slot.id + "/complete",
    sender.token,
    {
      operation_id: crypto.randomUUID(),
      content: {
        kind: "plain",
        markdown: "@" + names[0] + " look at this",
        mentions: [],
        quotes: [],
        files: [slot.id],
      },
      reply_to: null,
    },
  );
  await page.waitForFunction(() => window.__shown.length > 0, null, {
    timeout: 15000,
  });
  const shown = await page.evaluate(() => window.__shown[0]);
  const { options } = shown;
  assert.equal(shown.title, room.name);
  assert.equal(options.tag, "rv:" + room.id);
  assert.match(options.body, /look at this/);
  assert.equal(options.renotify, true);
  assert.equal(
    options.silent,
    true,
    "the app's own sound replaces the system's",
  );
  assert.deepEqual(options.data, {
    rv: "message",
    account: options.data.account,
    room: room.id,
    message: posted.id,
    position: posted.position,
  });
  assert.match(options.icon, /^data:image\/png;base64,/);
  assert.match(options.image, /^data:image\/jpeg;base64,/);
  assert.deepEqual(
    options.actions.map((action) => [action.action, action.title]),
    [
      ["read", "Mark as read"],
      ["like", "Like"],
    ].slice(0, maxActions),
  );
  assert.ok(
    !JSON.stringify(shown).includes(receiver.token),
    "the token never reaches a notification",
  );
  assert.equal(
    await page.evaluate(() => window.__constructed.length),
    0,
    "the worker showed it, no constructed fallback",
  );
  await until(
    () =>
      page.evaluate(() =>
        window.__played.some((src) => /cue-message/.test(src)),
      ),
    "the app's message sound",
  );
  console.log(
    "PASS the worker notification carries the photo, the picture, the buttons, silent + own sound, no token",
  );
  const before = await reads();
  assert.notEqual(before.unread_roots, "0", JSON.stringify(before));

  // Like: the tab adds 👍 with its own session, in the background.
  const kept = await click(options.data, "like");
  console.log("notifications kept by the browser:", kept);
  const liked = await until(async () => {
    const message = (await messages()).find((m) => m.id === posted.id);
    return message?.reactions?.find((reaction) =>
      reaction.users.some((user) => user.id === receiver.user.id),
    );
  }, "the 👍 reaction");
  console.log("PASS Like reached the server as", liked.emoji);
  // A second Like keeps it (added, never toggled off).
  await click(options.data, "like");
  await page.waitForTimeout(800);
  assert.ok(
    (await messages())
      .find((m) => m.id === posted.id)
      .reactions?.some((r) => r.emoji === liked.emoji),
  );
  console.log("PASS a second Like does not remove the reaction");

  // An inline reply, as Chromium hands it where the system shows a field.
  await click(options.data, "reply", "answer from the notification " + tag);
  await until(
    async () =>
      (await messages()).some(
        (m) =>
          m.author.id === receiver.user.id &&
          m.text === "answer from the notification " + tag,
      ),
    "the inline reply",
  );
  console.log("PASS an inline reply is sent through the outbox");

  // Mark as read: the whole room.
  await click(options.data, "read");
  await until(async () => {
    const state = await reads();
    return (
      state.unread_roots === "0" &&
      BigInt(state.root_position) >= BigInt(posted.position)
    );
  }, "the room read");
  console.log("PASS Mark as read reached the server");
  assert.equal(new URL(page.url()).pathname, "/", "buttons never navigate");

  // The settings switch gives the system's sound back.
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  const soundSwitch = page.getByLabel("Vibez sound");
  assert.equal(await soundSwitch.isChecked(), true);
  await soundSwitch.uncheck();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.__shown.length = 0;
    window.__played.length = 0;
  });
  const second = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    sender.token,
    {
      operation_id: crypto.randomUUID(),
      text: "@" + names[0] + " second",
    },
  );
  await page.waitForFunction(() => window.__shown.length > 0, null, {
    timeout: 15000,
  });
  const quiet = await page.evaluate(() => window.__shown[0].options);
  assert.equal(quiet.silent, false);
  assert.equal(quiet.data.message, second.id);
  assert.equal(quiet.image, undefined, "no picture in a text message");
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(
      () => window.__played.filter((src) => /cue-message/.test(src)).length,
    ),
    0,
  );
  console.log(
    "PASS the switch off posts with the system's sound, no own sound",
  );
  await page.evaluate(() => localStorage.removeItem("rv-notification-sound"));

  // A plain click opens the room with the composer focused.
  await click(options.data, "");
  await page.waitForURL("**/room/" + room.id);
  await until(
    () =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("composer-input"),
      ),
    "the composer focused",
  );
  console.log("PASS a click opens the room with the composer focused");
  const toasts = await page.locator(".toast").allTextContents();
  assert.deepEqual(toasts, [], "no error toast");

  // No tab open: the worker keeps the click until a tab says it is ready.
  // `clients.openWindow` needs a real click, so the test opens the tab.
  await page.close();
  const third = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    sender.token,
    { operation_id: crypto.randomUUID(), text: "while no tab is open" },
  );
  assert.notEqual((await reads()).unread_roots, "0");
  await click(
    { ...options.data, message: third.id, position: third.position },
    "read",
  );
  const later = await context.newPage();
  await later.goto(base);
  await later.locator(".status-dot.online").waitFor();
  await until(async () => {
    const state = await reads();
    return (
      state.unread_roots === "0" &&
      BigInt(state.root_position) >= BigInt(third.position)
    );
  }, "the read handed to the tab opened later");
  await later.close();
  console.log("PASS a click with no tab open is performed by the next tab");
} catch (error) {
  await page
    .screenshot({ path: "../../.cache/web-shots/notifications-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
