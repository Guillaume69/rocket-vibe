import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const names = [
  process.env.RV_WEB_PROFILE_USER || "webprofile",
  process.env.RV_WEB_PROFILE_PEER || "webprofilepeer",
];
assert.ok(names.every((name) => name.startsWith("webprofile")));
async function api(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = r.status === 204 ? undefined : await r.json();
  assert.ok(r.ok, path + " " + r.status + " " + JSON.stringify(data));
  return data;
}
const accounts = [];
for (const username of names)
  accounts.push(
    await api("/api/v1/auth/login", undefined, {
      username,
      password: "web-client-disposable-password",
    }),
  );
const tag = crypto.randomUUID().slice(0, 8);
async function changePeer(suffix) {
  const own = await api("/api/v1/me/profile", accounts[1].token);
  await api(
    "/api/v1/me",
    accounts[1].token,
    {
      operation_id: crypto.randomUUID(),
      expected_revision: own.profile.revision,
      username: names[1],
      display_name: "Profile peer " + tag + suffix,
      bio: "Profile biography " + tag + suffix,
      status: suffix ? "away" : "online",
      status_text: "Profile status " + tag + suffix,
    },
    "PATCH",
  );
}
await changePeer("");
const room = await api("/api/v1/rooms", accounts[0].token, {
  name: "profiles-" + tag,
  private: true,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + accounts[1].user.id,
  accounts[0].token,
  null,
);
const message = await api(
  "/api/v1/rooms/" + room.id + "/messages",
  accounts[1].token,
  { operation_id: crypto.randomUUID(), text: "Profile row " + tag },
);
const ownMessage = await api(
  "/api/v1/rooms/" + room.id + "/messages",
  accounts[0].token,
  { operation_id: crypto.randomUUID(), text: "Own profile row " + tag },
);
await mkdir("../../.cache", { recursive: true });
await writeFile(
  "../../.cache/profile-fixture.json",
  JSON.stringify({ username: names[0], room: room.name }),
);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const contexts = [],
  pages = [],
  errors = [];
try {
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
      }),
      page = await context.newPage();
    contexts.push(context);
    pages.push(page);
    await context.addInitScript(() => {
      const NativeSocket = WebSocket;
      window.WebSocket = new Proxy(NativeSocket, {
        construct(Target, args) {
          const socket = new Target(...args);
          if (String(args[0]).includes("/api/v1/sync/socket"))
            socket.addEventListener("message", (event) => {
              if (
                window.__holdProfileLive &&
                JSON.parse(event.data).type === "live"
              )
                event.stopImmediatePropagation();
            });
          return socket;
        },
      });
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByLabel("Username").fill(names[index]);
    await page
      .getByLabel("Password", { exact: true })
      .fill("web-client-disposable-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('.room-row[data-room="' + room.id + '"]').click();
    await page.locator('[data-id="' + message.id + '"]').waitFor();
  }
  const page = pages[0],
    row = page.locator('[data-id="' + message.id + '"]'),
    popup = page.locator(".user-profile-dialog");
  await row.locator(".message-gutter button").click();
  await popup
    .locator(".details-name")
    .filter({ hasText: "Profile peer " + tag })
    .waitFor();
  assert.equal(
    await popup.locator(".profile-username").textContent(),
    "@" + names[1],
  );
  assert.equal(
    await popup.locator(".profile-bio").textContent(),
    "Profile biography " + tag,
  );
  await popup
    .locator(".profile-presence")
    .filter({ hasText: "Online" })
    .waitFor();
  const rect = await popup.boundingBox();
  assert.ok(rect.width >= 418 && rect.width <= 422);
  assert.ok(rect.height >= 518 && rect.height <= 522);
  assert.equal(
    await popup
      .locator(".tile-profile")
      .evaluate((e) => e.getBoundingClientRect().width),
    96,
  );
  assert.equal(
    await popup.getByRole("button", { name: "Message", exact: true }).count(),
    1,
  );
  assert.equal(
    await popup.getByRole("button", { name: "Call", exact: true }).count(),
    1,
  );
  assert.equal(
    await popup
      .getByRole("button", { name: "Report this user", exact: true })
      .count(),
    1,
  );
  await mkdir("../../.cache/web-shots", { recursive: true });
  await page.screenshot({
    path: "../../.cache/web-shots/web-message-profile-reference.png",
  });
  console.log(
    "PASS clicking a message avatar opens the GTK-sized profile with its real user facts and actions",
  );
  await changePeer(" updated");
  await popup.locator(".details-name").filter({ hasText: "updated" }).waitFor();
  await popup.locator(".profile-bio").filter({ hasText: "updated" }).waitFor();
  await popup
    .locator(".profile-presence")
    .filter({ hasText: "Away" })
    .waitFor();
  console.log("PASS an open profile follows real profile and presence changes");
  await page.evaluate(() => {
    window.__holdProfileLive = true;
  });
  await popup
    .locator(".profile-presence")
    .filter({ hasText: "Away" })
    .waitFor({ state: "hidden", timeout: 12000 });
  assert.equal(await popup.locator(".profile-presence").textContent(), "");
  await page.evaluate(() => {
    window.__holdProfileLive = false;
  });
  await popup
    .locator(".profile-presence")
    .filter({ hasText: "Away" })
    .waitFor();
  // The account block opens a menu: settings, administration, sign out.
  await pages[1]
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await pages[1]
    .getByRole("menuitem", { name: "Sign out", exact: true })
    .click();
  await popup
    .locator(".profile-presence")
    .filter({ hasText: "Offline" })
    .waitFor();
  console.log(
    "PASS expired live observations disappear and a signed-out peer becomes Offline",
  );
  await pages[1].getByLabel("Username").fill(names[1]);
  await pages[1]
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await pages[1].getByRole("button", { name: "Sign in", exact: true }).click();
  await pages[1].locator('.room-row[data-room="' + room.id + '"]').click();
  await page.keyboard.press("Escape");
  await popup.waitFor({ state: "detached" });
  await row.locator(".author").click();
  await popup.locator(".details-name").waitFor();
  await popup
    .getByRole("button", { name: "Report this user", exact: true })
    .click();
  await page.getByLabel("Reason").waitFor();
  await popup.waitFor({ state: "detached" });
  assert.equal(await popup.count(), 0);
  await page.keyboard.press("Escape");
  await page.locator('[data-id="' + ownMessage.id + '"] .author').click();
  await popup.locator(".details-name").waitFor();
  assert.equal(await popup.locator(".profile-actions").count(), 0);
  assert.equal(await popup.locator(".report-user").count(), 0);
  await page.keyboard.press("Escape");
  console.log(
    "PASS author names open the same card, reporting replaces it and my own card hides other-person actions",
  );
  await row.locator(".author").click();
  await popup.locator(".details-name").waitFor();
  await popup.getByRole("button", { name: "Message", exact: true }).click();
  await popup.waitFor({ state: "detached" });
  await page.waitForFunction(
    () =>
      document.querySelector(".room-row.selected .tile")?.textContent !== "#",
  );
  assert.equal(
    await page.locator(".room-row.selected").getAttribute("data-room"),
    (
      await api("/api/v1/direct-messages", accounts[0].token, {
        user_id: accounts[1].user.id,
      })
    ).id,
  );
  await page.locator('.room-row[data-room="' + room.id + '"]').click();
  await row.locator(".message-gutter button").click();
  await popup.locator(".details-name").waitFor();
  await page.setViewportSize({ width: 390, height: 600 });
  const narrow = await popup.boundingBox();
  assert.ok(narrow.width <= 358 && narrow.height <= 560);
  await page.keyboard.press("Escape");
  console.log(
    "PASS profile Message opens the real DM and the card stays inside a narrow viewport",
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await row.locator(".author").click();
  const callResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/voice/"))
      callResponses.push([new URL(response.url()).pathname, response.status()]);
  });
  await popup.getByRole("button", { name: "Call", exact: true }).click();
  const incoming = pages[1].locator("dialog").filter({
    has: pages[1].getByRole("heading", {
      name: "Incoming call",
      exact: true,
    }),
  });
  await incoming.waitFor().catch(async (error) => {
    await page.screenshot({
      path: "../../.cache/web-shots/profile-call-failure.png",
    });
    console.log(
      JSON.stringify({
        callResponses,
        toasts: await page.locator(".toast").allTextContents(),
        heading: await page.locator(".room-heading").allTextContents(),
      }),
    );
    throw error;
  });
  await incoming.getByRole("button", { name: "Decline", exact: true }).click();
  await page.locator(".voice-bar").waitFor({ state: "detached" });
  console.log(
    "PASS profile Call opens the DM, rings its peer and decline closes the call",
  );
  assert.deepEqual(errors, []);
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  for (const account of accounts)
    await api("/api/v1/auth/logout", account.token, null).catch(() => {});
}
