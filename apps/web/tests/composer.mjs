import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_COMPOSER_USER || "webalice";
const password = "web-client-disposable-password";
async function fixture(path, token, body) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, path + " " + JSON.stringify(value));
  return value;
}
const session = await fixture("/api/v1/auth/login", null, {
  username,
  password,
});
const room = await fixture("/api/v1/rooms", session.token, {
  name: "composer-" + crypto.randomUUID().slice(0, 8),
  private: false,
  operation_id: crypto.randomUUID(),
});
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
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
  const input = page.locator(".room-content .rich-composer");
  await input.fill("**bold** _italic_ ~strike~ \x60code\x60");
  assert.equal(await input.locator(".draft-bold").textContent(), "bold");
  assert.equal(await input.locator(".draft-italic").textContent(), "italic");
  assert.equal(await input.locator(".draft-strike").textContent(), "strike");
  assert.equal(await input.locator(".draft-code").textContent(), "code");
  console.log("PASS GTK inline draft styles with original text preserved");
  await input.fill("hello 🦄");
  await input.press("Control+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  assert.equal(await input.evaluate((node) => node.value), "**hello 🦄**");
  assert.equal(
    await input.evaluate((node) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    ),
    "hello 🦄",
  );
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  assert.equal(await input.evaluate((node) => node.value), "hello 🦄");
  await input.press("Control+z");
  assert.equal(await input.evaluate((node) => node.value), "**hello 🦄**");
  await input.press("Control+Shift+z");
  assert.equal(await input.evaluate((node) => node.value), "hello 🦄");
  console.log("PASS format toggle, unicode selection, undo and redo");
  await input.fill("1. item");
  await input.press("End");
  await input.press("Shift+Enter");
  assert.equal(await input.evaluate((node) => node.value), "1. item\n2. ");
  await input.press("Shift+Enter");
  assert.equal(await input.evaluate((node) => node.value), "1. item\n");
  console.log("PASS native multiline editing and list continuation");
  await input.fill("# Heading\n_italic_\nlast");
  assert.equal(
    await input.evaluate((node) => node.value),
    "# Heading\n_italic_\nlast",
  );
  assert.ok(await input.locator(".draft-marker[hidden]").count());
  console.log(
    "PASS markers hidden away from the cursor line without deleting markup",
  );
  await input.fill("");
  await input.evaluate((node) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "<img src=x onerror=evil()>");
    clipboardData.setData("text/html", "<img src=x onerror=evil()>");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(await input.locator("img").count(), 0);
  assert.equal(
    await input.evaluate((node) => node.value),
    "<img src=x onerror=evil()>",
  );
  console.log("PASS pasted rich content is inserted as text only");
  await input.fill("Draft from styled editor 🦄");
  await page.reload();
  await page.locator(".room-content .rich-composer").waitFor();
  assert.equal(
    await page
      .locator(".room-content .rich-composer")
      .evaluate((node) => node.value),
    "Draft from styled editor 🦄",
  );
  console.log("PASS styled editor drafts survive a real reload");
  await page.locator(".room-content .rich-composer").fill("");
  await page.screenshot({ path: "../../.cache/web-shots/composer.png" });
} catch (error) {
  console.log(
    "Editor UI:",
    await page.locator(".login-error, .toast").allTextContents(),
  );
  await page.screenshot({
    path: "../../.cache/web-shots/composer-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
