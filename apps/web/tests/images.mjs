import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_IMAGE_USER || "webimage",
  peername = process.env.RV_WEB_IMAGE_PEER || "webimagepeer";
assert.ok(username.startsWith("webimage") && peername.startsWith("webimage"));
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
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, path + " " + response.status);
  return data;
}
const user = await api("/api/v1/auth/login", null, { username, password });
const peer = await api("/api/v1/auth/login", null, {
  username: peername,
  password,
});
const room = await api("/api/v1/rooms", peer.token, {
  name: "images-" + crypto.randomUUID().slice(0, 8),
  private: true,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + user.user.id,
  peer.token,
  null,
);
await mkdir("../../.cache/web-shots", { recursive: true });
await writeFile(
  "../../.cache/image-room.json",
  JSON.stringify({
    id: room.id,
    name: room.name,
    owner: peername,
    member: username,
  }),
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
// Qualify the PNG payload without replacing the user's OS clipboard.
await page.addInitScript(() => {
  navigator.clipboard.write = async (items) => {
    const blob = await items[0].getType("image/png");
    const pixels = await createImageBitmap(blob);
    window.imageClipboardFixture = {
      type: blob.type,
      width: pixels.width,
      height: pixels.height,
    };
    pixels.close();
  };
});
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
  const files = await page.evaluate(() =>
    [
      [512, 256],
      [180, 800],
      [64, 64],
    ].map(([width, height], index) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const draw = canvas.getContext("2d");
      draw.fillStyle = "#35d5ce";
      draw.fillRect(0, 0, width, height);
      draw.fillStyle = "#ff5fa2";
      draw.fillRect(width / 4, height / 4, width / 2, height / 2);
      return {
        name: "gtk-image-" + index + ".png",
        base64: canvas.toDataURL("image/png").split(",")[1],
      };
    }),
  );
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Attach a file", exact: true })
    .click();
  await (
    await chooser
  ).setFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: "image/png",
      buffer: Buffer.from(file.base64, "base64"),
    })),
  );
  await page.locator(".staged-chip").first().waitFor();
  assert.deepEqual(
    await page
      .locator(".staged-thumb")
      .evaluateAll((thumbs) =>
        thumbs.map((thumb) => [
          thumb.getBoundingClientRect().width,
          thumb.getBoundingClientRect().height,
        ]),
      ),
    [
      [40, 40],
      [40, 40],
      [40, 40],
    ],
  );
  await page
    .locator(".room-content .rich-composer")
    .fill("GTK image references");
  await page.locator(".room-content .rich-composer").press("Enter");
  await page.locator(".image-frame img").nth(2).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".image-frame img")].every(
      (image) => image.naturalWidth > 0,
    ),
  );
  const posted = (
    await api("/api/v1/rooms/" + room.id + "/messages", user.token)
  ).messages
    .filter((message) => message.files?.length)
    .sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1));
  assert.deepEqual(
    posted.map((message) => message.files[0].filename),
    ["gtk-image-0.png", "gtk-image-1.png", "gtk-image-2.png"],
  );
  assert.deepEqual(
    posted.map((message) => message.text),
    ["GTK image references", "", ""],
  );
  const sizes = await page.locator(".image-frame").evaluateAll((frames) =>
    frames.map((frame) => ({
      width: frame.getBoundingClientRect().width,
      height: frame.getBoundingClientRect().height,
      fit: getComputedStyle(frame.querySelector("img")).objectFit,
    })),
  );
  assert.deepEqual(
    sizes.sort((a, b) => a.width - b.width),
    [
      { width: 120, height: 120, fit: "cover" },
      { width: 180, height: 300, fit: "cover" },
      { width: 360, height: 180, fit: "cover" },
    ],
  );
  assert.equal(await page.locator(".image-card .file-top").count(), 0);
  await page.screenshot({
    path: "../../.cache/web-shots/web-image-inline-reference.png",
  });
  console.log(
    "PASS original protected images match GTK inline size limits and crop without a file header",
  );
  await page
    .locator(".image-card")
    .filter({ has: page.locator('img[alt="gtk-image-2.png"]') })
    .locator(".image-frame")
    .click();
  const smallViewer = page.locator(".gtk-image-dialog");
  assert.equal(
    await smallViewer.evaluate((node) =>
      Math.round(node.getBoundingClientRect().width),
    ),
    320,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-image-small-viewer-reference.png",
  });
  await smallViewer
    .locator(".image-viewer")
    .click({ position: { x: 1, y: 20 } });
  await smallViewer.waitFor({ state: "detached" });
  const card = page
    .locator(".image-card")
    .filter({ has: page.locator('img[alt="gtk-image-0.png"]') });
  await card.locator(".image-frame").click();
  const viewer = page.locator(".gtk-image-dialog");
  await viewer.waitFor();
  assert.equal(
    await viewer.evaluate((node) =>
      Math.round(node.getBoundingClientRect().width),
    ),
    512,
  );
  const image = await viewer.locator(".image-viewer").elementHandle();
  await viewer.locator(".image-viewer").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
  await page.waitForFunction(() => window.imageClipboardFixture);
  assert.deepEqual(await page.evaluate(() => window.imageClipboardFixture), {
    type: "image/png",
    width: 512,
    height: 256,
  });
  await viewer.locator(".image-viewer").click({ button: "right" });
  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save as…", exact: true }).click();
  const download = await pendingDownload;
  assert.equal(download.suggestedFilename(), "gtk-image-0.png.png");
  const bytes = await readFile(await download.path());
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 512);
  assert.equal(bytes.readUInt32BE(20), 256);
  await viewer.locator(".image-viewer").click({ button: "right" });
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Open in the default app", exact: true })
      .count(),
    1,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-image-viewer-menu-reference.png",
  });
  const pendingOpen = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Open in the default app", exact: true })
    .click();
  assert.equal((await pendingOpen).suggestedFilename(), "gtk-image-0.png.png");
  console.log(
    "PASS the native image menu prepares full-size PNG copy/save data and maps the default-app action",
  );
  const messageId = await card.evaluate(
    (node) => node.closest("[data-id]").dataset.id,
  );
  await api(
    "/api/v1/messages/" + messageId + "/reactions",
    peer.token,
    { emoji: "thumbsup", present: true, operation_id: crypto.randomUUID() },
    "PUT",
  );
  await page
    .locator('[data-id="' + messageId + '"] .reactions')
    .filter({ hasText: "1" })
    .waitFor();
  assert.equal(await image.evaluate((node) => node.isConnected), true);
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + user.user.id,
    peer.token,
    undefined,
    "DELETE",
  );
  await viewer.waitFor({ state: "detached" });
  assert.equal(await image.evaluate((node) => node.hasAttribute("src")), false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS live reactions retain the viewer and membership withdrawal closes it and removes private pixels",
  );
  const staging = await api("/api/v1/rooms", peer.token, {
    name: "staged-" + crypto.randomUUID().slice(0, 8),
    private: true,
    operation_id: crypto.randomUUID(),
  });
  await api(
    "/api/v1/rooms/" + staging.id + "/members/" + user.user.id,
    peer.token,
    null,
  );
  const parking = await api("/api/v1/rooms", user.token, {
    name: "parking-" + crypto.randomUUID().slice(0, 8),
    private: true,
    operation_id: crypto.randomUUID(),
  });
  await page
    .locator('[data-room="' + staging.id + '"]')
    .first()
    .click();
  const large = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400;
      canvas.height = 1200;
      const draw = canvas.getContext("2d");
      draw.fillStyle = "#34e1d0";
      draw.fillRect(0, 0, 2400, 1200);
      draw.fillStyle = "#ff5fa2";
      draw.fillRect(100, 100, 2200, 1000);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  async function pick(name) {
    const chosen = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Attach a file", exact: true })
      .click();
    await (
      await chosen
    ).setFiles({ name, mimeType: "image/png", buffer: large });
    await page.locator(".staged-chip").waitFor();
  }
  await pick("original-source.png");
  await page.getByLabel("Images in original quality", { exact: true }).check();
  await page
    .getByRole("button", { name: "Preview original-source.png", exact: true })
    .click();
  await page.locator(".gtk-image-dialog").waitFor();
  assert.equal(await page.locator(".gtk-image-dialog select").count(), 0);
  assert.equal(await page.getByLabel("Caption", { exact: true }).count(), 0);
  await page
    .locator(".gtk-image-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .locator('[data-room="' + parking.id + '"]')
    .first()
    .click();
  await page
    .locator('[data-room="' + staging.id + '"]')
    .first()
    .click();
  assert.equal(
    await page
      .getByLabel("Images in original quality", { exact: true })
      .isChecked(),
    true,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-staged-original-reference.png",
  });
  await page.locator(".room-content .rich-composer").fill("Original source");
  await page.locator(".room-content .rich-composer").press("Enter");
  await page.locator('img[alt="original-source.png"]').waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('img[alt="original-source.png"]')?.naturalWidth ===
      2400,
  );
  await pick("reduced-source.png");
  await page
    .getByLabel("Images in original quality", { exact: true })
    .uncheck();
  await page.locator(".room-content .rich-composer").fill("Reduced source");
  await page.locator(".room-content .rich-composer").press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector('img[alt="reduced-source.jpg"]')?.naturalWidth ===
      1920,
  );
  assert.equal(
    await page
      .locator('img[alt="reduced-source.jpg"]')
      .evaluate((image) => image.naturalHeight),
    960,
  );
  const sent = (
    await api("/api/v1/rooms/" + staging.id + "/messages", user.token)
  ).messages
    .filter((message) => message.files?.length)
    .sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1));
  assert.deepEqual(
    sent.map((message) => message.files[0].media_type),
    ["image/png", "image/jpeg"],
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS GTK staged thumbnails and parked original-quality choice preserve originals or reduce to JPEG 1920, with ordered single-caption batches",
  );
} catch (error) {
  await page
    .screenshot({ path: "../../.cache/web-shots/images-failure.png" })
    .catch(() => {});
  console.log(
    "Image UI:",
    await page
      .locator(".toast")
      .allTextContents()
      .catch(() => []),
  );
  throw error;
} finally {
  await browser.close();
}
