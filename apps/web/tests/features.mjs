import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const aliceName = process.env.RV_WEB_ALICE || "webalice";
const bobName = process.env.RV_WEB_BOB || "webbob";
const password = "web-client-disposable-password";
const api = async (
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, path + " " + JSON.stringify(value));
  return value;
};
const alice = await api("/api/v1/auth/login", null, {
    username: aliceName,
    password,
  }),
  bob = await api("/api/v1/auth/login", null, { username: bobName, password }),
  tag = "features-" + crypto.randomUUID().slice(0, 8);
const room = await api("/api/v1/rooms", alice.token, {
  name: tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
  alice.token,
  null,
);
const message = await api("/api/v1/rooms/" + room.id + "/messages", bob.token, {
  operation_id: crypto.randomUUID(),
  text: "Live message " + tag,
});
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const contexts = [],
  pages = [],
  errors = [];
async function menu(page, id) {
  await page.locator(".actions-menu").waitFor({ state: "detached" });
  await page.locator('[data-id="' + id + '"] .row-more').click();
  await page.locator(".actions-menu").waitFor({ state: "visible" });
}
async function history() {
  return (await api("/api/v1/rooms/" + room.id + "/messages", alice.token))
    .messages;
}
try {
  for (const username of [aliceName, bobName]) {
    const context = await browser.newContext({
      permissions: ["microphone", "camera"],
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".shell").waitFor();
    await page
      .locator('[data-room="' + room.id + '"]')
      .first()
      .click();
    await page.locator('[data-id="' + message.id + '"]').waitFor();
  }
  const [a, b] = pages;
  await b.locator(".room-content .rich-composer").fill("Typing draft " + tag);
  await a.locator(".typing").filter({ hasText: bobName }).waitFor();
  console.log("PASS typing between two live browser sessions");
  await menu(a, message.id);
  await a.getByRole("button", { name: "Pin", exact: true }).click();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      (
        await api("/api/v1/rooms/" + room.id + "/pins", alice.token)
      ).messages.some((item) => item.id === message.id)
    )
      break;
    await a.waitForTimeout(100);
  }
  assert.ok(
    (
      await api("/api/v1/rooms/" + room.id + "/pins", alice.token)
    ).messages.some((item) => item.id === message.id),
  );
  await menu(a, message.id);
  await a.getByRole("button", { name: "Star", exact: true }).click();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      (
        await api("/api/v1/rooms/" + room.id + "/stars", alice.token)
      ).messages.some((item) => item.id === message.id)
    )
      break;
    await a.waitForTimeout(100);
  }
  assert.ok(
    (
      await api("/api/v1/rooms/" + room.id + "/stars", alice.token)
    ).messages.some((item) => item.id === message.id),
  );
  console.log("PASS pins and personal stars");
  await menu(a, message.id);
  await a
    .locator(".actions-menu")
    .getByRole("button", { name: "Quote", exact: true })
    .click();
  await a.locator(".reply-bar").waitFor({ state: "visible" });

  await a.locator(".room-content .rich-composer").fill("Quoted reply " + tag);
  await a.locator(".room-content .rich-composer").press("Enter");
  await a
    .locator(".timeline article .message-body")
    .filter({ hasText: "Quoted reply " + tag })
    .waitFor();
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await history()).some((item) => item.text === "Quoted reply " + tag))
      break;
    await a.waitForTimeout(100);
  }

  assert.ok(
    (await history())
      .find((item) => item.text === "Quoted reply " + tag)
      ?.quotes?.some((quote) => quote.reference.message_id === message.id),
  );
  console.log("PASS quote references and safe excerpts");
  await menu(a, message.id);
  await a.getByRole("button", { name: "Reports", exact: true }).click();
  await a.getByLabel("Reason").fill("Browser moderation " + tag);
  await a
    .locator("dialog")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await a.getByRole("button", { name: "Settings", exact: true }).click();
  await a
    .getByRole("button", { name: "Server administration", exact: true })
    .click();
  await a.getByRole("button", { name: "Moderation", exact: true }).click();
  const reported = a
    .locator(".admin-reports .action-row")
    .filter({ hasText: message.text });
  await reported.first().click();
  await a
    .locator(".preferences-page")
    .getByText("Browser moderation " + tag, { exact: true })
    .waitFor();
  await a.getByRole("button", { name: "Dismiss", exact: true }).click();
  await a
    .locator(".alert-dialog")
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await a.locator(".admin-reports").waitFor();
  await a.locator(".sidebar-dialog .preferences-close").click();
  console.log("PASS report and moderator dismissal through the application");
  await a
    .locator(".room-content")
    .getByRole("button", { name: "Record a voice message", exact: true })
    .click();
  await a
    .getByRole("button", { name: "Stop recording", exact: true })
    .waitFor();
  const duringRecording = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    bob.token,
    { text: "Live during recording " + tag, operation_id: crypto.randomUUID() },
  );
  await a.locator('[data-id="' + duringRecording.id + '"]').waitFor();
  await a.waitForTimeout(1200);
  await a.getByRole("button", { name: "Stop recording", exact: true }).click();
  await a.locator(".staged-chip").waitFor();
  assert.ok(
    !(await history()).some((item) =>
      item.files?.some((file) => file.media_type.startsWith("audio/")),
    ),
  );
  await a.locator(".room-content .rich-composer").fill("Audio caption " + tag);
  await a.locator(".room-content .rich-composer").press("Enter");
  await a.locator(".file-title").filter({ hasText: "voice-" }).waitFor();
  const audioMessage = (await history()).find(
    (item) => item.text === "Audio caption " + tag,
  );
  assert.ok(
    audioMessage?.files?.some((file) => file.media_type.startsWith("audio/")),
  );
  const card = a.locator('[data-id="' + audioMessage.id + '"] [data-file-id]');
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await card.locator("audio").waitFor({ state: "attached" });
  await card.locator("audio").evaluate(
    (player) =>
      new Promise((resolve, reject) => {
        if (player.currentTime > 0) return resolve();
        const deadline = setTimeout(
          () => reject(new Error("Audio did not advance")),
          10000,
        );
        player.addEventListener("timeupdate", () => {
          if (player.currentTime > 0) {
            clearTimeout(deadline);
            resolve();
          }
        });
      }),
  );
  assert.equal(await card.locator(".audio-controls").count(), 1);
  await card.locator("audio").evaluate((player) => {
    player.dataset.proof = "retained";
  });
  await menu(a, audioMessage.id);
  await a.getByRole("button", { name: "👍", exact: true }).click();
  assert.equal(
    await card.locator("audio").getAttribute("data-proof"),
    "retained",
  );
  console.log(
    "PASS staged recording, captions, protected audio and playback widget retained during reactions",
  );
  await contexts[0].setOffline(true);
  await a.reload();
  await a.locator(".shell").waitFor();
  const offlineCard = a.locator(
    '[data-id="' + audioMessage.id + '"] [data-file-id]',
  );
  await offlineCard.getByRole("button", { name: "Play", exact: true }).click();
  await offlineCard.locator("audio").waitFor({ state: "attached" });
  await contexts[0].setOffline(false);
  console.log("PASS private IndexedDB media cache survives offline reload");
  const metadata = await api("/api/v1/rooms/" + room.id, alice.token);
  await api(
    "/api/v1/rooms/" + room.id,
    alice.token,
    {
      operation_id: crypto.randomUUID(),
      expected_revision: metadata.revision,
      name: metadata.room.name,
      private: false,
      topic: metadata.topic,
      description: metadata.description,
      announcement: metadata.announcement,
      read_only: true,
    },
    "PATCH",
  );
  await b.waitForFunction(
    () =>
      document.querySelector(".room-content .rich-composer")?.disabled === true,
  );
  assert.equal(await b.locator(".room-content .composer").isVisible(), false);
  console.log("PASS read-only permissions update live and hide the composer");
  const updated = await api("/api/v1/rooms/" + room.id, alice.token);
  await api(
    "/api/v1/rooms/" + room.id,
    alice.token,
    {
      operation_id: crypto.randomUUID(),
      expected_revision: updated.revision,
      name: updated.room.name,
      private: false,
      topic: updated.topic,
      description: updated.description,
      announcement: updated.announcement,
      read_only: false,
    },
    "PATCH",
  );
  await b.waitForFunction(
    () =>
      document.querySelector(".room-content .rich-composer")?.disabled ===
      false,
  );
  await contexts[1].setOffline(true);
  await b
    .locator(".room-content .rich-composer")
    .fill("Retired membership " + tag);
  await b.locator(".room-content .rich-composer").press("Enter");
  await b.locator(".pending-row").waitFor();
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
    alice.token,
    undefined,
    "DELETE",
  );
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
    alice.token,
    null,
  );
  await contexts[1].setOffline(false);
  await b.locator(".pending-row").waitFor({ state: "detached" });
  assert.ok(
    !(await history()).some(
      (item) => item.text === "Retired membership " + tag,
    ),
  );
  console.log(
    "PASS membership withdrawal and rejoin cannot replay the old offline send",
  );
  const cachedRequests = await a.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        urls.push(new URL(request.url).pathname);
    return urls;
  });
  assert.ok(cachedRequests.length > 0);
  assert.ok(
    cachedRequests.every(
      (path) => !path.startsWith("/api/") && !path.startsWith("/.well-known/"),
    ),
  );
  console.log("PASS service worker caches only the public application shell");
  assert.deepEqual(errors, []);
} catch (error) {
  console.error("Feature failure:", error.message);
  for (let index = 0; index < pages.length; index++) {
    console.log(
      "Feature UI:",
      await pages[index]
        .locator(".toast")
        .allTextContents()
        .catch(() => []),
    );
    await pages[index]
      .screenshot({
        path: "../../.cache/web-shots/features-failure-" + index + ".png",
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
}
