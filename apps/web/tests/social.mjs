import assert from "node:assert/strict";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3418";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const password = "web-client-disposable-password";
const username = process.env.RV_WEB_SOCIAL_USER || "socialweb";
async function api(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = res.status === 204 ? undefined : await res.json();
  assert.ok(res.ok, path + " " + JSON.stringify(value));
  return value;
}
const alice = await api("/api/v1/auth/login", null, {
  username,
  password,
});
const room = await api("/api/v1/rooms", alice.token, {
  name: "Social " + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
const browser = await chromium.launch({
  headless: true,
  channel: process.env.RV_BROWSER_CHANNEL,
});
const page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1280, height: 850 },
  }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Search and media are controlled fixtures: the key stays on the server, and
// API writes, journals, voting, persistence and room changes are real.
await page.route("**/.well-known/vibez", async (route) => {
  const response = await route.fetch();
  const value = await response.json();
  value.capabilities.giphy = true;
  await route.fulfill({ response, json: value });
});
const searches = [];
let releaseSlow;
const slowGate = new Promise((resolve) => {
  releaseSlow = resolve;
});
await page.route("**/api/v1/gifs?*", async (route) => {
  const query = new URL(route.request().url()).searchParams.get("q");
  searches.push(query);
  if (query === "slow") await slowGate;
  await route.fulfill({
    json: {
      items:
        query === "empty"
          ? []
          : [
              {
                id: query + "-gif",
                title: query === "cat" ? "Cat GIF" : "Wave GIF",
                url: "https://media.giphy.com/social-test.gif",
                width: 1,
                height: 1,
                source: null,
              },
            ],
    },
  });
});
let imagePosts = 0,
  releaseSend;
const sendGate = new Promise((resolve) => {
  releaseSend = resolve;
});
await page.route("**/api/v1/rooms/*/images", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  imagePosts++;
  const response = await route.fetch();
  if (imagePosts === 1) await sendGate;
  await route.fulfill({ response });
});
await page.route("https://media.giphy.com/social-test.gif", (route) =>
  route.fulfill({
    contentType: "image/gif",
    body: Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    ),
  }),
);
const social = () =>
  page.getByRole("button", {
    name: "Polls, game nights, stickers and GIFs",
    exact: true,
  });
async function history() {
  return (await api("/api/v1/rooms/" + room.id + "/messages", alice.token))
    .messages;
}
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
  await social().click();
  const socialMenu = page.locator(".social-menu-dialog");
  assert.equal(Math.round((await socialMenu.boundingBox()).width), 600);
  assert.equal(Math.round((await socialMenu.boundingBox()).height), 220);
  await socialMenu
    .getByRole("button", { name: "Quick poll", exact: true })
    .click();
  let dialog = page.locator("dialog[open]");
  assert.equal(await dialog.locator("textarea").count(), 0);
  assert.deepEqual(
    await dialog.locator(".social-field span").allTextContents(),
    [
      "Title / question",
      "Options separated by |",
      "Optional closing time (YYYY-MM-DD HH:MM)",
    ],
  );
  assert.equal(
    Math.round(
      (await dialog.getByLabel("Title / question").boundingBox()).height,
    ),
    34,
  );
  assert.equal(
    await dialog
      .getByLabel("Title / question")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await dialog
    .getByLabel("Title / question", { exact: true })
    .fill("What should we play?");
  await dialog.getByLabel("Options separated by |").fill("Co-op | Racing");
  let creationRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/social")
    )
      creationRequests++;
  });
  const closing = dialog.getByLabel("Optional closing time (YYYY-MM-DD HH:MM)");
  await closing.fill("2027-02-30 20:00");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await dialog
    .getByRole("status")
    .getByText("Check the date and time.", { exact: true })
    .waitFor();
  assert.equal(
    creationRequests,
    0,
    "invalid native date stays inline without a mutation",
  );
  await closing.fill("");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  let card = page
    .locator(".social-card")
    .filter({ hasText: "What should we play?" });
  await card.waitFor();
  await card.getByLabel("Co-op", { exact: false }).check();
  await card.getByRole("button", { name: "Vote", exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".social-card")).some((c) =>
      c.textContent.includes("Co-op · 1"),
    ),
  );
  let poll = (await history()).find((m) => m.social?.kind === "poll");
  assert.equal(poll.social.options[0].voters.length, 1);
  await card
    .getByRole("button", { name: "Clear my vote", exact: true })
    .click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".social-card")).some((c) =>
      c.textContent.includes("Co-op · 0"),
    ),
  );
  await card.getByRole("button", { name: "Close poll", exact: true }).click();
  await card.getByText("Poll closed", { exact: true }).waitFor();
  console.log("PASS create poll, vote, clear and close against real server");
  await social().click();
  await socialMenu
    .getByRole("button", { name: "Game night", exact: true })
    .click();
  dialog = page.locator("dialog[open]");
  assert.deepEqual(
    await dialog.locator(".social-field span").allTextContents(),
    ["Title / question", "Details", "Date in your timezone (YYYY-MM-DD HH:MM)"],
  );
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pad = (number) => String(number).padStart(2, "0");
  assert.equal(
    await dialog
      .getByLabel("Date in your timezone (YYYY-MM-DD HH:MM)")
      .inputValue(),
    `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 20:00`,
  );
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  await dialog
    .getByLabel("Title / question", { exact: true })
    .fill("Friday co-op");
  const at = new Date(Date.now() + 86400000);
  await dialog
    .getByLabel("Date in your timezone (YYYY-MM-DD HH:MM)")
    .fill(
      new Date(at - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " "),
    );
  await dialog
    .getByLabel("Details", { exact: true })
    .fill("Bring a controller");
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const game = page.locator(".social-card").filter({ hasText: "Friday co-op" });
  await game.getByRole("button", { name: /^Going/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".game-night")).some((c) =>
      c.textContent.includes("Going · 1"),
    ),
  );
  console.log("PASS event local date/time and RSVP");
  const input = page.locator(".room-content .rich-composer");
  await input.fill("/giphy wave");
  dialog = page.locator("dialog[open]");
  await dialog.locator("img").waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Send", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await input.evaluate((n) => n.value), "/giphy wave");
  await input.press("Enter");
  dialog = page.locator("dialog[open]");
  await dialog.getByRole("button", { name: "Wave GIF", exact: true }).click();
  assert.equal(imagePosts, 0, "selection must not send a GIF");
  assert.equal(
    await dialog.locator('.gif-choice[aria-pressed="true"]').count(),
    1,
  );
  const query = dialog.getByLabel("Search GIFs", { exact: true });
  await query.fill("slow");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Send", exact: true })
      .isDisabled(),
    true,
  );
  await page.waitForRequest(
    (r) => new URL(r.url()).searchParams.get("q") === "slow",
  );
  await query.fill("cat");
  await dialog.getByRole("button", { name: "Cat GIF", exact: true }).waitFor();
  const oldResponse = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get("q") === "slow",
  );
  releaseSlow();
  await oldResponse;
  assert.equal(
    await dialog.getByRole("button", { name: "Wave GIF", exact: true }).count(),
    0,
  );
  await query.fill("empty");
  await dialog.getByText("No GIFs found.", { exact: true }).waitFor();
  await query.fill("c");
  await query.fill("ca");
  await query.fill("cat");
  await dialog.getByRole("button", { name: "Cat GIF", exact: true }).waitFor();
  assert.ok(
    !searches.includes("c") && !searches.includes("ca"),
    "intermediate keystrokes must be debounced",
  );
  await dialog.getByRole("button", { name: "Cat GIF", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save to sticker shelf", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.equal(
    (await history()).filter((m) => m.social?.kind === "image").length,
    0,
  );
  await page.screenshot({
    path:
      process.env.RV_GIPHY_SCREENSHOT || join(tmpdir(), "rv-giphy-picker.png"),
    fullPage: true,
  });
  const sentRequest = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/images"),
  );
  await query.press("Enter");
  await sentRequest;
  await query.press("Enter");
  assert.equal(
    imagePosts,
    1,
    "repeated Enter must not duplicate a send in flight",
  );
  releaseSend();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await input.evaluate((n) => n.value), "");
  await page.locator(".social-image img").waitFor();
  const imageCard = page
    .locator(".social-image")
    .filter({ hasText: "Cat GIF" });
  await imageCard.getByText("Cat GIF", { exact: true }).waitFor();
  const saveCard = imageCard.getByRole("button", {
    name: "Save to sticker shelf",
    exact: true,
  });
  assert.equal(
    await saveCard.evaluate((node) => node.getBoundingClientRect().height),
    34,
  );
  await saveCard.click();
  await imageCard.getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.equal(
    (await history()).filter((m) => m.social?.kind === "image").length,
    1,
  );
  assert.equal(
    (await history()).find((m) => m.social?.kind === "image").social.title,
    "Cat GIF",
  );
  await input.fill("a draft to keep");
  await social().click();
  await page
    .locator(".social-menu-dialog")
    .getByRole("button", { name: "GIF · Powered By GIPHY", exact: true })
    .click();
  dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Search GIFs", { exact: true }).fill("wave");
  await dialog.getByRole("button", { name: "Wave GIF", exact: true }).click();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(imagePosts, 2);
  assert.equal(await input.evaluate((n) => n.value), "a draft to keep");
  await input.fill("");
  assert.equal(
    (await history()).filter((m) => m.social?.kind === "image").length,
    2,
  );
  console.log(
    "PASS auto /giphy opening, live/debounced search, stale response, selection, cancel, Enter/Send, duplicate suppression, native image-card save receipt and actual messages",
  );
  await social().click();
  await page
    .locator(".social-menu-dialog")
    .getByRole("button", { name: "Sticker shelf", exact: true })
    .click();
  dialog = page.locator("dialog[open]");
  await dialog.locator("img").waitFor();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await social().click();
  await page
    .locator(".social-menu-dialog")
    .getByRole("button", { name: "Sticker shelf", exact: true })
    .click();
  dialog = page.locator("dialog[open]");
  await dialog.locator("img").waitFor();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByText("No images. Search or add a link.").waitFor();
  await page.keyboard.press("Escape");
  assert.equal((await api("/api/v1/stickers", alice.token)).stickers.length, 0);
  await page.screenshot({
    path:
      process.env.RV_SOCIAL_SCREENSHOT ||
      join(tmpdir(), "rv-social-browser.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS sticker persistence/removal, responsive layout and no browser exceptions",
  );
} catch (error) {
  console.error(
    "GIF test state",
    await page.locator("dialog[open]").allTextContents(),
    searches,
  );
  await page.screenshot({
    path: join(tmpdir(), "rv-giphy-failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
