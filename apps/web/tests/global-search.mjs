// Search across rooms, in this browser: the sidebar's search button and
// Ctrl+Shift+F find the words of messages the browser already holds in every
// room, newest first under their room's name, and a hit opens the message in
// its room or its thread. A message arriving live is found too.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_GLOBAL_SEARCH_USER || "webglobalsearch";
const password = "web-client-disposable-password";
const call = async (path, token, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
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
const tag = crypto.randomUUID().slice(0, 8);
const needle = "needle" + tag;
const room = (name) =>
  call("/api/v1/rooms", me.token, {
    name: name + "-" + tag,
    private: false,
    operation_id: crypto.randomUUID(),
  });
const alphaRoom = await room("search-alpha");
const betaRoom = await room("search-beta");
const send = (target, text, reply_to) =>
  call("/api/v1/rooms/" + target.id + "/messages", me.token, {
    operation_id: crypto.randomUUID(),
    text,
    ...(reply_to ? { reply_to } : {}),
  });
const alpha = await send(alphaRoom, "First " + needle + " in alpha");
await send(alphaRoom, "Nothing to find here");
const beta = await send(betaRoom, "Then " + needle.toUpperCase() + " in beta");
const reply = await send(
  alphaRoom,
  "A threaded " + needle + " reply",
  alpha.id,
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const hits = () =>
  page
    .locator(".local-search-dialog .local-hit")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.dataset.hit,
        node.querySelector(".local-hit-room")?.textContent,
      ]),
    );
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .getByRole("button", { name: "Search messages", exact: true })
    .click();
  const dialog = page.locator(".local-search-dialog");
  await dialog
    .getByText("Among the messages already in this browser")
    .waitFor();
  await dialog.getByLabel("Words, in every room").fill(needle);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".local-search-dialog .local-hit").length === 3,
  );
  assert.deepEqual(await hits(), [
    [reply.id, "#" + alphaRoom.name],
    [beta.id, "#" + betaRoom.name],
    [alpha.id, "#" + alphaRoom.name],
  ]);
  await page.screenshot({ path: "../../.cache/web-shots/global-search.png" });
  console.log("PASS hits across rooms, newest first, under their room");
  await dialog
    .locator('.local-hit[data-hit="' + alpha.id + '"]')
    .getByRole("button", { name: "Open message", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await page
    .locator('.timeline [data-id="' + alpha.id + '"].jump-highlight')
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/room/" + alphaRoom.id);
  console.log("PASS a hit opens its message in its room");
  // A live message is found too; Ctrl+Shift+F opens the same search.
  const live = await send(betaRoom, "Live " + needle + " arrival");
  await page.keyboard.press("Control+Shift+F");
  await dialog.getByLabel("Words, in every room").waitFor();
  await dialog.getByLabel("Words, in every room").fill(needle);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".local-search-dialog .local-hit").length === 4,
  );
  assert.equal((await hits())[0][0], live.id);
  console.log("PASS Ctrl+Shift+F, and a live message is found");
  await dialog
    .locator('.local-hit[data-hit="' + reply.id + '"]')
    .getByRole("button", { name: "Open message", exact: true })
    .click();
  await page.locator('.thread-pane [data-id="' + reply.id + '"]').waitFor();
  console.log("PASS a reply opens in its thread");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Search messages", exact: true })
    .click();
  await dialog.getByLabel("Words, in every room").fill("zz" + tag + "absent");
  await dialog.getByText("No message contains these words.").waitFor();
  // A click outside closes it with nothing opened.
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: "detached" });
  console.log("PASS no hit says so, a click outside closes it");
} finally {
  await browser.close();
}
