// Threads: the room's list (latest reply first, All / Following), following
// set by replying, Unfollow from the list, a follow made in another session
// showing live in the open thread, and "Also send to the room".
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_THREADS_USER || "webthreads";
const peerName = process.env.RV_WEB_THREADS_PEER || "webthreadspeer";
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
const me = await call("/api/v1/auth/login", null, { username, password });
const peer = await call("/api/v1/auth/login", null, {
  username: peerName,
  password,
});
const discovery = await call("/.well-known/vibez");
for (const capability of [
  "thread_list",
  "thread_follow",
  "thread_also_in_room",
])
  assert.ok(discovery.capabilities[capability], capability + " announced");
const room = await call("/api/v1/rooms", me.token, {
  name: "threads-" + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
await call(
  "/api/v1/rooms/" + room.id + "/members/" + peer.user.id,
  me.token,
  null,
);
const say = (token, text, root) =>
  call("/api/v1/rooms/" + room.id + "/messages", token, {
    operation_id: crypto.randomUUID(),
    text,
    ...(root ? { reply_to: root } : {}),
  });
const first = await say(peer.token, "First peer root");
const second = await say(peer.token, "Second peer root");
await say(peer.token, "A reply to the first", first.id);
await say(peer.token, "A reply to the second", second.id);
const following = async () =>
  (
    await call(
      "/api/v1/rooms/" + room.id + "/threads?filter=following",
      me.token,
    )
  ).threads.map((thread) => thread.root.id);
assert.deepEqual(await following(), [], "a bystander follows nothing");

await mkdir("../../.cache/web-shots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const order = () =>
  page
    .locator("dialog.threads-dialog .thread-entry")
    .evaluateAll((rows) => rows.map((row) => row.dataset.thread));
const openList = async () => {
  if (await page.locator(".thread-pane").isVisible())
    await page.locator(".thread-pane .thread-back").click();
  await page.locator(".room-heading").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Threads", exact: true }).click();
  await page.locator("dialog.threads-dialog").waitFor();
};
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await page.locator(".room-content .rich-composer").waitFor();

  await openList();
  await page.locator("dialog.threads-dialog .thread-entry").first().waitFor();
  assert.deepEqual(await order(), [second.id, first.id], "latest reply first");
  await page
    .locator("dialog.threads-dialog")
    .getByRole("tab", { name: "Following", exact: true })
    .click();
  await page
    .locator("dialog.threads-dialog")
    .getByText("No threads", { exact: true })
    .waitFor();
  console.log("PASS the list puts the latest reply first; Following is empty");

  // Open the first thread from the list and reply, also to the room.
  await page
    .locator("dialog.threads-dialog")
    .getByRole("tab", { name: "All", exact: true })
    .click();
  await page
    .locator(
      'dialog.threads-dialog .thread-entry[data-thread="' + first.id + '"]',
    )
    .getByRole("button", { name: "Open thread", exact: true })
    .click();
  const pane = page.locator(".thread-pane");
  await pane.locator(".rich-composer").waitFor();
  assert.equal(
    await page.locator(".room-content").isVisible(),
    false,
    "GTK thread replaces the room view",
  );
  assert.equal(await pane.locator(".composer-pill").count(), 1);
  assert.equal(await pane.locator(".format-bar button").count(), 10);
  await pane.locator(".rich-composer").fill("Thread draft");
  await pane.locator(".rich-composer").press("Control+a");
  await pane
    .getByRole("button", { name: "Bold (Ctrl+B)", exact: true })
    .click();
  assert.equal(
    await pane.locator(".rich-composer").evaluate((node) => node.value),
    "*Thread draft*",
  );
  const shown = pane.getByRole("checkbox", { name: "Also send to the room" });
  await shown.check();
  await pane.locator(".rich-composer").fill("My reply, also in the room");
  await pane.locator(".rich-composer").press("Enter");
  await page
    .locator(".thread-pane .timeline")
    .getByText("My reply, also in the room")
    .waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => !document.querySelector(".thread-pane .also-in-room input")?.checked,
  );
  assert.equal(await shown.isChecked(), false, "the box is for one reply");
  await page
    .locator(".room-content .timeline")
    .getByRole("button", {
      name: "Replied in a thread",
      exact: true,
      includeHidden: true,
    })
    .waitFor({ state: "attached" });
  const history = await call(
    "/api/v1/rooms/" + room.id + "/messages?also_in_room=true",
    me.token,
  );
  const mine = history.messages.find(
    (message) => message.text === "My reply, also in the room",
  );
  assert.ok(mine?.also_in_room, "the server keeps the flag");
  assert.equal(mine.reply_to, first.id, "it stays a reply");
  const plain = await call("/api/v1/rooms/" + room.id + "/messages", me.token);
  assert.ok(
    !plain.messages.some((message) => message.id === mine.id),
    "an older client's history keeps roots only",
  );
  // A plain reply right after stays in its thread.
  await pane.locator(".rich-composer").fill("Only in the thread");
  await pane.locator(".rich-composer").press("Enter");
  await pane.getByText("Only in the thread").waitFor({ timeout: 15000 });
  assert.equal(
    await page
      .locator(".room-content .timeline")
      .getByText("Only in the thread")
      .count(),
    0,
  );
  console.log("PASS Also send to the room shows one reply in the room");

  // Replying made me follow; the header bell says so.
  assert.deepEqual(await following(), [first.id], "following set by replying");
  const bell = pane.locator(".thread-follow");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-pane .thread-follow")
        ?.getAttribute("aria-pressed") === "true",
  );
  await openList();
  await page.locator("dialog.threads-dialog .thread-entry").first().waitFor();
  assert.deepEqual(
    await order(),
    [first.id, second.id],
    "my reply moved it up",
  );
  await page
    .locator("dialog.threads-dialog")
    .getByRole("tab", { name: "Following", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll("dialog.threads-dialog .thread-entry")]
        .map((row) => row.dataset.thread)
        .join() === id,
    first.id,
  );
  console.log("PASS replying follows the thread");

  // Unfollow from the list row.
  const row = page.locator(
    'dialog.threads-dialog .thread-entry[data-thread="' + first.id + '"]',
  );
  await row.getByRole("button", { name: "Unfollow", exact: true }).click();
  await row.getByRole("button", { name: "Follow", exact: true }).waitFor();
  assert.deepEqual(await following(), [], "unfollowed on the server");
  await page.screenshot({ path: "../../.cache/web-shots/threads.png" });
  await page.keyboard.press("Escape");
  await page
    .locator('.room-content [data-id="' + first.id + '"] .thread-chip')
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-pane .thread-follow")
        ?.getAttribute("aria-pressed") === "false",
  );
  console.log("PASS Unfollow from the list, the open thread follows");

  // Another session of mine follows it again: the open thread shows it live.
  await call(
    "/api/v1/messages/" + first.id + "/follow",
    me.token,
    { operation_id: crypto.randomUUID(), present: true },
    "PUT",
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-pane .thread-follow")
        ?.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 15000 },
  );
  // And the header bell unfollows too.
  await bell.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-pane .thread-follow")
        ?.getAttribute("aria-pressed") === "false",
  );
  assert.deepEqual(await following(), []);
  console.log("PASS a follow from another session shows live");
} catch (error) {
  await page.screenshot({ path: "../../.cache/web-shots/threads-failure.png" });
  throw error;
} finally {
  await browser.close();
}
