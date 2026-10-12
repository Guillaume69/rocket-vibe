// GTK completion previews over real Unicode/custom catalogs and protected assets.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
const username = process.env.RV_WEB_EMOJI_USER || "webemojipreview";
const adminName = process.env.RV_WEB_EMOJI_ADMIN || "webemojipreviewadmin";
const password = "web-client-disposable-password";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.ok(username.startsWith("webemojipreview"));
assert.ok(adminName.startsWith("webemojipreview"));
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
  assert.ok(response.ok, path + " " + response.status);
  return response.status === 204 ? undefined : response.json();
}
const me = await api("/api/v1/auth/login", null, { username, password });
const admin = await api("/api/v1/auth/login", null, {
  username: adminName,
  password,
});
const tag = crypto.randomUUID().slice(0, 8);
const customName = "rvpreview_" + tag + "_custom",
  alias = "rvpreview_" + tag + "_alias",
  lateName = "rvpreview_" + tag + "_late";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await context.newPage();
const errors = [],
  foreignCredentials = [],
  imageRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url()),
    headers = request.headers();
  if (
    url.protocol.startsWith("http") &&
    url.origin !== new URL(base).origin &&
    (headers.authorization || headers.cookie)
  )
    foreignCredentials.push({ origin: url.origin, path: url.pathname });
  if (url.pathname.startsWith("/api/v1/emoji/files/"))
    imageRequests.push(request);
});
const gate = Promise.withResolvers();
await mkdir("../../.cache/web-shots", { recursive: true });
const buffer = async (color) =>
  Buffer.from(
    await page.evaluate((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 8, 8);
      return canvas.toDataURL("image/png").split(",")[1];
    }, color),
    "base64",
  );
const createEmoji = async (name, aliases, bytes) => {
  const response = await fetch(
    base +
      "/api/v1/admin/emoji/" +
      name +
      "?operation_id=" +
      crypto.randomUUID() +
      "&aliases=" +
      encodeURIComponent(aliases),
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + admin.token,
        "Content-Type": "image/png",
      },
      body: bytes,
    },
  );
  assert.ok(response.ok, "the disposable custom emoji is accepted");
  return (await response.json()).items.find((item) => item.name === name);
};
const value = (input) => input.evaluate((node) => node.value);
const inserted = async (input, text) =>
  page.waitForFunction(
    ([node, expected]) => node.value === expected,
    [await input.elementHandle(), text],
  );
const loaded = async (image) => {
  await image.waitFor();
  await page.waitForFunction(
    (node) => node.complete && node.naturalWidth > 0,
    await image.elementHandle(),
  );
};
const sent = () =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/rooms/" + room.id + "/messages" &&
      response.request().method() === "POST",
  );
let room;
try {
  const custom = await createEmoji(customName, alias, await buffer("#39e1cf"));
  const late = await createEmoji(lateName, "", await buffer("#536dff"));
  assert.notEqual(custom.file_id, late.file_id);
  assert.equal(
    (await fetch(base + "/api/v1/emoji/files/" + custom.file_id)).status,
    401,
    "custom pixels require authentication",
  );
  room = await api("/api/v1/rooms", me.token, {
    name: "emoji-preview-" + tag,
    private: false,
    operation_id: crypto.randomUUID(),
  });
  const root = await api("/api/v1/rooms/" + room.id + "/messages", me.token, {
    text: "Disposable thread root",
    operation_id: crypto.randomUUID(),
  });
  const loadedCatalog = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/emoji",
  );
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const loggedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/auth/start" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const browserStep = await (await loggedIn).json();
  assert.equal(browserStep.kind, "session");
  const browserSession = browserStep.session;
  const catalogResponse = await loadedCatalog;
  assert.ok(catalogResponse.ok());
  assert.equal(
    (await catalogResponse.request().allHeaders()).authorization,
    "Bearer " + browserSession.token,
  );
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  const main = page.locator(".room-content .rich-composer"),
    choices = page.locator(".room-content .completion");
  await main.fill("Preview :grinning");
  const standard = choices.getByRole("button", {
    name: ":grinning:",
    exact: true,
  });
  await standard.waitFor();
  assert.equal(
    await standard.locator(".completion-preview").textContent(),
    "😀",
  );
  const previewBox = await standard
      .locator(".completion-preview")
      .boundingBox(),
    codeBox = await standard.locator(".completion-code").boundingBox();
  assert.ok(
    previewBox.width > 0 && codeBox.x >= previewBox.x + previewBox.width + 4,
    "the visible glyph precedes its shortcode with GTK spacing",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-emoji-standard-completion-reference.png",
  });
  await standard.click();
  await inserted(main, "Preview :grinning: ");
  assert.equal(await main.locator("img,svg").count(), 0);
  const standardSent = sent();
  await main.press("Enter");
  const standardResponse = await standardSent;
  assert.equal(
    standardResponse.request().postDataJSON().text.trim(),
    "Preview :grinning:",
  );
  assert.equal(
    (await standardResponse.json()).text.trim(),
    "Preview :grinning:",
  );
  await main.fill("Keyboard :grin");
  await choices.locator(".completion-row").first().waitFor();
  assert.ok((await choices.locator(".completion-row").count()) <= 8);
  await main.press("ArrowDown");
  const keyboardCode = await choices
    .locator(".chosen .completion-code")
    .textContent();
  await main.press("Tab");
  await inserted(main, "Keyboard " + keyboardCode + " ");
  console.log(
    "PASS Unicode previews precede shortcodes; click and Arrow/Tab insert plain colon text and send it unchanged",
  );

  await main.fill("Alias :" + alias);
  const customChoice = choices.getByRole("button", {
    name: ":" + alias + ":",
    exact: true,
  });
  await loaded(customChoice.locator("img.custom-emoji"));
  assert.equal(
    await customChoice
      .locator("img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  assert.ok(
    (await customChoice.locator("img").getAttribute("src")).startsWith(
      "blob:" + new URL(base).origin,
    ),
  );
  assert.ok(
    imageRequests.some((request) =>
      new URL(request.url()).pathname.endsWith("/" + custom.file_id),
    ),
    "an alias fetches the canonical protected image",
  );
  const imageHeaders = await Promise.all(
    imageRequests.map((request) => request.allHeaders()),
  );
  assert.ok(
    imageHeaders.every(
      (headers) =>
        headers.authorization === "Bearer " + browserSession.token &&
        !headers.cookie,
    ),
    "protected image requests use only the captured same-origin bearer",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-emoji-custom-completion-reference.png",
  });
  await main.press("Enter");
  await inserted(main, "Alias :" + alias + ": ");
  const customSent = sent();
  await main.press("Enter");
  const customResponse = await customSent;
  assert.equal(
    customResponse.request().postDataJSON().text.trim(),
    "Alias :" + alias + ":",
  );
  assert.equal(
    (await customResponse.json()).text.trim(),
    "Alias :" + alias + ":",
  );
  console.log(
    "PASS a real custom alias shows loaded protected pixels and Enter sends its shortcode without HTML",
  );

  const fetched = Promise.withResolvers();
  const latePath = "/api/v1/emoji/files/" + late.file_id;
  await page.route("**" + latePath, async (route) => {
    try {
      const response = await route.fetch();
      assert.ok(response.ok());
      fetched.resolve();
      await gate.promise;
      await route.fulfill({ response });
    } catch (error) {
      fetched.reject(error);
    }
  });
  const lateRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === latePath,
  );
  await main.fill(":" + lateName);
  await lateRequest;
  await fetched.promise;
  await main.fill("Changed draft before image arrived");
  assert.equal(await choices.locator("button").count(), 0);
  const lateAnswer = page.waitForResponse(
    (response) => new URL(response.url()).pathname === latePath,
  );
  gate.resolve();
  assert.ok((await lateAnswer).ok());
  assert.equal(await choices.locator("img").count(), 0);
  assert.equal(await value(main), "Changed draft before image arrived");
  await page.unroute("**" + latePath);
  console.log(
    "PASS a held protected image cannot repopulate completion after its captured prefix is retired",
  );

  await main.fill("");
  await page
    .locator('.room-content [data-id="' + root.id + '"] .row-more')
    .click();
  await page
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const thread = page.locator(".thread-pane .rich-composer"),
    threadChoices = page.locator(".thread-pane .completion");
  await thread.fill("Thread :grinning");
  await threadChoices
    .getByRole("button", { name: ":grinning:", exact: true })
    .waitFor();
  assert.equal(
    await threadChoices
      .getByRole("button", { name: ":grinning:", exact: true })
      .locator(".completion-preview")
      .textContent(),
    "😀",
  );
  await thread.press("Tab");
  await inserted(thread, "Thread :grinning: ");
  await thread.fill("Thread :" + customName);
  const threadCustom = threadChoices.getByRole("button", {
    name: ":" + customName + ":",
    exact: true,
  });
  await loaded(threadCustom.locator("img"));
  assert.equal(
    await threadCustom
      .locator("img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-emoji-thread-completion-reference.png",
  });
  await thread.press("Enter");
  await inserted(thread, "Thread :" + customName + ": ");
  const threadSent = sent();
  await thread.press("Enter");
  const threadResponse = await threadSent;
  assert.equal(threadResponse.request().postDataJSON().reply_to, root.id);
  assert.equal(
    threadResponse.request().postDataJSON().text.trim(),
    "Thread :" + customName + ":",
  );
  assert.equal(
    (await threadResponse.json()).text.trim(),
    "Thread :" + customName + ":",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(foreignCredentials, []);
  console.log(
    "PASS the thread composer shares Unicode/custom previews, Tab/Enter selection and plain-text replies without page errors or foreign credentials",
  );
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/emoji-completion-failure.png",
  });
  throw error;
} finally {
  gate.resolve();
  await context.close();
  await browser.close();
  const catalog = await api("/api/v1/emoji", admin.token).catch(() => ({
    items: [],
  }));
  for (const name of [customName, lateName]) {
    const item = catalog.items.find((item) => item.name === name);
    if (item)
      await fetch(
        base +
          "/api/v1/admin/emoji/" +
          name +
          "?operation_id=" +
          crypto.randomUUID() +
          "&expected_revision=" +
          encodeURIComponent(item.revision),
        {
          method: "DELETE",
          headers: { Authorization: "Bearer " + admin.token },
        },
      ).catch(() => {});
  }
}
