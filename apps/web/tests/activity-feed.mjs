// The Activity view: the sidebar's bell and Ctrl+Shift+A list, from what the
// browser holds, the messages that mention me, the replies in my threads and
// the reactions others left on my messages, newest first; an item opens its
// message (a reply in its thread), a click outside closes it.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const [username, other, third] = (
  process.env.RV_WEB_ACTIVITY_USERS ||
  "webactivity,webactivitybob,webactivitycarol"
).split(",");
const password = "web-client-disposable-password";
const call = async (path, token, body, method) => {
  const response = await fetch(base + path, {
    method: method || (body === undefined ? "GET" : "POST"),
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
const login = (name) =>
  call("/api/v1/auth/login", null, { username: name, password });
const [me, bob, carol] = [
  await login(username),
  await login(other),
  await login(third),
];
const tag = crypto.randomUUID().slice(0, 8);
const room = await call("/api/v1/rooms", me.token, {
  name: "activity-" + tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
for (const person of [bob, carol])
  await call("/api/v1/rooms/" + room.id + "/join", person.token, null);
const send = (who, text, reply_to) =>
  call("/api/v1/rooms/" + room.id + "/messages", who.token, {
    operation_id: crypto.randomUUID(),
    text,
    ...(reply_to ? { reply_to } : {}),
  });
const react = (who, message, emoji) =>
  call(
    "/api/v1/messages/" + message.id + "/reactions",
    who.token,
    { operation_id: crypto.randomUUID(), emoji, present: true },
    "PUT",
  );
const root = await send(me, "My thread " + tag);
const reply = await send(bob, "An answer in your thread " + tag, root.id);
const mention = await send(bob, "Look @" + username + " " + tag);
await send(bob, "Nothing for you " + tag);
const mine = await send(me, "Rate this " + tag);
await react(carol, mine, "tada");
await react(bob, mine, "tada");
await react(me, mine, "+1");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const items = () =>
  page
    .locator(".activity-feed-dialog .activity-feed-item")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.dataset.id,
        node.dataset.kind,
        node.querySelector(".activity-feed-what")?.textContent,
      ]),
    );
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .getByRole("button", { name: "Activity (Ctrl+Shift+A)", exact: true })
    .click();
  const dialog = page.locator(".activity-feed-dialog");
  await dialog.getByRole("heading", { name: "Recent" }).waitFor();
  const ours = (await items()).filter(([id]) =>
    [mine.id, mention.id, reply.id].includes(id),
  );
  assert.deepEqual(ours, [
    [mine.id, "reaction", third + ", " + other + " reacted 🎉"],
    [mention.id, "mention", "Mentioned you"],
    [reply.id, "reply", "Replied in a thread"],
  ]);
  await page.screenshot({ path: "../../.cache/web-shots/activity-feed.png" });
  console.log("PASS mentions, thread replies and reactions, newest first");
  await dialog.locator('[data-id="' + mention.id + '"]').click();
  await dialog.waitFor({ state: "detached" });
  await page
    .locator('.timeline [data-id="' + mention.id + '"].jump-highlight')
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/room/" + room.id);
  console.log("PASS an item opens its message in its room");
  await page.keyboard.press("Control+Shift+A");
  await dialog.locator('[data-id="' + reply.id + '"]').click();
  await page.locator('.thread-pane [data-id="' + reply.id + '"]').waitFor();
  console.log("PASS Ctrl+Shift+A, and a reply opens in its thread");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+A");
  await dialog.getByRole("heading", { name: "Recent" }).waitFor();
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: "detached" });
  console.log("PASS a click outside closes it");
} finally {
  await browser.close();
}
