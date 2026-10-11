import assert from "node:assert/strict";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3418";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const password = "web-client-disposable-password";
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
  username: "socialweb",
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
await page.route("**/.well-known/rocketvibe", async (route) => {
  const response = await route.fetch();
  const value = await response.json();
  value.capabilities.giphy = true;
  await route.fulfill({ response, json: value });
});
await page.route("**/api/v1/gifs?*", (route) =>
  route.fulfill({
    json: {
      items: [
        {
          id: "wave-gif",
          title: "Wave GIF",
          url: "https://media.giphy.com/social-test.gif",
          width: 1,
          height: 1,
          source: null,
        },
      ],
    },
  }),
);
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
  await page.getByLabel("Username or email").fill("socialweb");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await social().click();
  await page.getByRole("menuitem", { name: "Quick poll", exact: true }).click();
  let dialog = page.locator("dialog[open]");
  await dialog
    .getByLabel("Question", { exact: true })
    .fill("What should we play?");
  await dialog.getByLabel("One option per line (2–10)").fill("Co-op\nRacing");
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
      c.textContent.includes("1 participants"),
    ),
  );
  let poll = (await history()).find((m) => m.social?.kind === "poll");
  assert.equal(poll.social.options[0].voters.length, 1);
  await card
    .getByRole("button", { name: "Clear my vote", exact: true })
    .click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".social-card")).some((c) =>
      c.textContent.includes("0 participants"),
    ),
  );
  await card.getByRole("button", { name: "Close poll", exact: true }).click();
  await card.getByText("Poll closed", { exact: true }).waitFor();
  console.log("PASS create poll, vote, clear and close against real server");
  await social().click();
  await page.getByRole("menuitem", { name: "Game night", exact: true }).click();
  dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Title", { exact: true }).fill("Friday co-op");
  const at = new Date(Date.now() + 86400000);
  await dialog
    .getByLabel("Date and time in your timezone")
    .fill(
      new Date(at - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
  await dialog.getByLabel("Game, server, details…").fill("Bring a controller");
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
  await input.press("Enter");
  dialog = page.locator("dialog[open]");
  await dialog.locator("img").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await input.evaluate((n) => n.value), "/giphy wave");
  await input.press("Enter");
  dialog = page.locator("dialog[open]");
  await dialog
    .getByRole("button", { name: "Save to sticker shelf", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await input.evaluate((n) => n.value), "");
  await page.locator(".social-image img").waitFor();
  assert.equal(
    (await history()).filter((m) => m.social?.kind === "image").length,
    1,
  );
  console.log(
    "PASS /giphy picker, cancel, send, animation media element and save",
  );
  await social().click();
  await page
    .getByRole("menuitem", { name: "Sticker shelf", exact: true })
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
    .getByRole("menuitem", { name: "Sticker shelf", exact: true })
    .click();
  dialog = page.locator("dialog[open]");
  await dialog.locator("img").waitFor();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog
    .getByText("Add your images or save a GIF from search.")
    .waitFor();
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
} finally {
  await browser.close();
}
