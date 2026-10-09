import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_WORKFLOWS_USER || "webworkflows";
const password = "web-client-disposable-password";
const tag = crypto.randomUUID().slice(0, 8);
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
  const value = response.status === 204 ? undefined : await response.json();
  assert.ok(
    response.ok,
    method + " " + path + " " + response.status + " " + JSON.stringify(value),
  );
  return value;
}
const account = await api("/api/v1/auth/login", null, { username, password });
const room = await api("/api/v1/rooms", account.token, {
  name: "workflow-web-" + tag,
  private: false,
  operation_id: crypto.randomUUID(),
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
const botProfileFrames = [];
page.on("websocket", (socket) => {
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "live") botProfileFrames.push(frame.data.profiles || []);
  });
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let bot, workflow;
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor({ timeout: 45000 });
  // The account block opens a menu: settings, administration, sign out.
  await page.getByRole("button", { name: "My account, settings and sign out", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.locator(".settings-dialog");
  await settings.locator("[data-category=bots]").click();
  await settings
    .getByRole("button", { name: "Create a bot", exact: true })
    .click();
  await settings.getByLabel("Username", { exact: true }).fill("botweb" + tag);
  await settings
    .getByLabel("Display name", { exact: true })
    .fill("Workflow bot " + tag);
  await settings
    .getByLabel("Description", { exact: true })
    .fill("Disposable browser fixture");
  for (const scope of [
    "rooms:read",
    "messages:write",
    "rooms:join",
    "users:read",
  ])
    await settings.getByLabel(scope, { exact: true }).check();
  const createdBot = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/bots") && r.request().method() === "POST",
  );
  await settings
    .getByRole("button", { name: "Create a bot", exact: true })
    .click();
  const botResponse = await createdBot;
  assert.ok(botResponse.ok(), "Create bot refused");
  bot = await botResponse.json();
  await settings.getByLabel("Label", { exact: true }).fill("Browser fixture");
  const keyResponse = page.waitForResponse(
    (r) => r.url().endsWith("/keys") && r.request().method() === "POST",
  );
  await settings
    .getByRole("button", { name: "Create key", exact: true })
    .click();
  const keyResult = await (await keyResponse).json();
  const secret = page.locator(".secret-dialog");
  await secret.waitFor();
  assert.equal(
    await secret.locator("code").first().textContent(),
    keyResult.key,
  );
  await secret.locator(".dialog-header button").click();
  await secret.waitFor({ state: "detached" });
  assert.equal(await page.getByText(keyResult.key, { exact: true }).count(), 0);
  await api("/api/v1/rooms/" + room.id + "/join", keyResult.key, null);
  console.log(
    "PASS create bot, native scopes, one-time key and real bot API room membership",
  );
  await settings.locator("[data-category=workflows]").click();
  await settings
    .getByRole("button", { name: "Create a workflow", exact: true })
    .click();
  await settings.getByLabel("Bot", { exact: true }).selectOption(bot.user.id);
  await settings.getByLabel("Name", { exact: true }).fill("Workflow " + tag);
  await settings
    .getByLabel("Description", { exact: true })
    .fill("Browser form end-to-end");
  const command = "hello-web-" + tag;
  await settings.getByLabel("Command name", { exact: true }).fill(command);
  await settings.getByLabel("Add a step", { exact: true }).selectOption("form");
  await settings
    .getByRole("button", { name: "Add a step", exact: true })
    .click();
  await settings
    .getByLabel("Form title", { exact: true })
    .fill("Browser question " + tag);
  const field = settings.locator(".workflow-field").first();
  await field.getByLabel("Label", { exact: true }).fill("Your answer");
  await field.getByLabel("Kind", { exact: true }).selectOption("choice");
  await field
    .getByLabel("Options, separated by commas", { exact: true })
    .fill("Alpha, Beta");
  await settings
    .getByLabel("Add a step", { exact: true })
    .selectOption("message");
  await settings
    .getByRole("button", { name: "Add a step", exact: true })
    .click();
  await settings
    .getByLabel("Text", { exact: true })
    .fill("You chose {{form.answers.your_answer}}");
  await page.screenshot({
    path: "../../.cache/web-shots/web-workflow-editor.png",
  });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/workflows") && r.request().method() === "POST",
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  const savedResponse = await saved;
  assert.ok(savedResponse.ok(), "Create workflow refused");
  workflow = await savedResponse.json();
  assert.equal(workflow.trigger.name, command);
  assert.equal(workflow.bot.id, bot.user.id);
  assert.equal(workflow.enabled, true);
  assert.equal(workflow.steps.length, 2);
  await settings.locator(".preferences-close").click();
  await page.locator(".room-row").filter({ hasText: room.name }).click();
  await page
    .locator(".composer-input")
    .first()
    .fill("/" + command.slice(0, -2));
  await page.locator(".completion-item").filter({ hasText: command }).waitFor();
  await page
    .locator(".composer-input")
    .first()
    .fill("/" + command + " input");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page
    .locator(".workflow-form-card")
    .filter({ hasText: "Browser question " + tag });
  await card.waitFor({ timeout: 30000 });
  const beforeProfiles = botProfileFrames.length;
  for (
    let attempts = 0;
    botProfileFrames.length < beforeProfiles + 2 && attempts < 60;
    attempts++
  )
    await page.waitForTimeout(100);
  assert.ok(
    botProfileFrames.length >= beforeProfiles + 2,
    "Observe two real profile updates after the bot's message",
  );
  for (const profiles of botProfileFrames.slice(beforeProfiles)) {
    const observed = profiles.find((stamp) => stamp.user.id === bot.user.id);
    assert.equal(
      observed?.user.bot,
      true,
      "Live profiles must retain the workflow bot identity",
    );
  }
  assert.equal(
    await card
      .locator("xpath=ancestor::article")
      .locator(".message-heading .bot-badge")
      .count(),
    1,
  );
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await card.waitFor();
  assert.equal(
    await card
      .locator("xpath=ancestor::article")
      .locator(".message-heading .bot-badge")
      .count(),
    1,
  );
  console.log(
    "PASS workflow BOT badges survive actual live profile refreshes and page reload",
  );
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  const answer = page.locator(".workflow-form-dialog");
  await answer
    .getByLabel("Your answer *", { exact: true })
    .selectOption("Beta");
  await answer.getByRole("button", { name: "Submit", exact: true }).click();
  await card
    .getByText("Answered by", { exact: false })
    .waitFor({ timeout: 30000 });
  await page
    .locator(".message-column")
    .getByText("You chose Beta", { exact: true })
    .waitFor({ timeout: 30000 });
  console.log(
    "PASS hyphenated room command completion, workflow form, answer and templated continuation",
  );
  await page.locator(".composer-input").first().fill("/invalid!command");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .locator("#toasts")
    .getByText("Invalid slash command", { exact: true })
    .waitFor();
  const messages = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    account.token,
  );
  assert.ok(!messages.messages.some((m) => m.text === "/invalid!command"));
  console.log("PASS invalid slash input cannot leak as a plaintext message");
  await page.screenshot({
    path: "../../.cache/web-shots/web-workflow-form.png",
  });
  // The account block opens a menu: settings, administration, sign out.
  await page.getByRole("button", { name: "My account, settings and sign out", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const preferences = page.locator(".settings-dialog");
  await preferences.locator("[data-category=workflows]").click();
  await preferences
    .getByRole("button")
    .filter({ hasText: "Workflow " + tag })
    .click();
  await preferences
    .getByLabel("Description", { exact: true })
    .fill("Unsaved description retained by disable");
  const disabled = page.waitForResponse((r) => r.url().endsWith("/disable"));
  await preferences
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await disabled;
  assert.equal(
    await preferences.getByLabel("Description", { exact: true }).inputValue(),
    "Unsaved description retained by disable",
  );
  const update = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/workflows/" + workflow.id) &&
      r.request().method() === "PUT",
  );
  await preferences.getByRole("button", { name: "Save", exact: true }).click();
  const stored = await (await update).json();
  assert.equal(stored.enabled, false);
  assert.equal(stored.description, "Unsaved description retained by disable");
  console.log(
    "PASS disabling retains unsaved fields and saves at the successor revision",
  );
  await preferences.getByLabel("When", { exact: true }).selectOption("webhook");
  for (const select of await preferences
    .getByLabel("Room", { exact: true })
    .all())
    await select.selectOption(room.id);
  await preferences
    .getByLabel("Who answers", { exact: true })
    .selectOption("anyone");
  const hookSave = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/workflows/" + workflow.id) &&
      r.request().method() === "PUT",
  );
  await preferences.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal((await (await hookSave).json()).trigger.kind, "webhook");
  await preferences
    .getByRole("button", { name: "Generate URL", exact: true })
    .click();
  const hookSecret = page.locator(".secret-dialog");
  await hookSecret.waitFor();
  const hookURL = await hookSecret.locator("code").textContent();
  assert.equal(new URL(hookURL).origin, base);
  await hookSecret.locator(".dialog-header button").click();
  await hookSecret.waitFor({ state: "detached" });
  assert.equal(await page.getByText(hookURL, { exact: true }).count(), 0);
  console.log(
    "PASS saved webhook generation shows the URL once without persisting it",
  );

  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  console.error(errors);
  console.error(
    await page
      .locator(".composer-input")
      .first()
      .evaluate((node) => ({
        text: node.value,
        selection: node.selectionStart,
        completion: document.querySelector(".completion")?.textContent,
      }))
      .catch(() => null),
  );
  await page
    .screenshot({ path: "../../.cache/web-shots/web-workflow-failed.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  if (workflow)
    await api(
      "/api/v1/workflows/" + workflow.id,
      account.token,
      undefined,
      "DELETE",
    );
  if (bot?.user)
    await api(
      "/api/v1/bots/" + bot.user.id,
      account.token,
      undefined,
      "DELETE",
    );
  await api("/api/v1/rooms/" + room.id + "/leave", account.token, {
    operation_id: crypto.randomUUID(),
  }).catch(() => {});
}
