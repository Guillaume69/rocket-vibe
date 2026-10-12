// GTK EntryRows, composer glyphs and the verified-email route, using real data.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_GTK_FORMS_USER || "webgtkforms",
  peerName = process.env.RV_WEB_GTK_FORMS_PEER || "webgtkformspeer",
  password = "web-client-disposable-password";
assert.ok([username, peerName].every((name) => name.startsWith("webgtk")));
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
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, path + " " + response.status);
  return response.status === 204 ? undefined : response.json();
}
const me = await api("/api/v1/auth/login", undefined, { username, password });
const peer = await api("/api/v1/auth/login", undefined, {
  username: peerName,
  password,
});
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
const errors = [],
  creations = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    request.method() === "POST" &&
    ["/api/v1/rooms", "/api/v1/direct-messages"].includes(
      new URL(request.url()).pathname,
    )
  )
    creations.push(new URL(request.url()).pathname);
});
const settings = async (category = "My account") => {
  await page
    .getByRole("button", {
      name: "My account, settings and sign out",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .locator(".sidebar-categories")
    .getByRole("button", { name: category, exact: true })
    .click();
};
const spotlight = async () => {
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "New message", exact: true })
    .click();
  const dialog = page.locator(".new-message-dialog");
  await dialog.waitFor();
  return dialog;
};
const newConversation = async () => {
  const search = await spotlight();
  await search
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  const dialog = page.locator(".new-conversation-dialog");
  await dialog.waitFor();
  return dialog;
};
async function codeToolbar(container, label) {
  const input = container.locator(".rich-composer"),
    button = container.getByRole("button", {
      name: "Code (Ctrl+E)",
      exact: true,
    });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await container
        .locator("header.headerbar")
        .first()
        .evaluate((node) => {
          const header = node.getBoundingClientRect();
          return [...node.children].every((child) => {
            const bounds = child.getBoundingClientRect();
            return (
              !bounds.width ||
              !bounds.height ||
              (bounds.top >= header.top - 1 &&
                bounds.bottom <= header.bottom + 1)
            );
          });
        }),
      true,
      label + " header contents stay within the header at " + width,
    );
    assert.equal(await button.textContent(), "</>");
    const geometry = await button.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(
          (rect) => rect.width && rect.height,
        ),
        box = node.getBoundingClientRect();
      return {
        lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
        inside: rects.every(
          (rect) =>
            rect.left >= box.left &&
            rect.right <= box.right &&
            rect.top >= box.top &&
            rect.bottom <= box.bottom,
        ),
        nowrap: getComputedStyle(node).whiteSpace,
      };
    });
    assert.equal(
      geometry.lines,
      1,
      label + " code glyph remains one line at " + width,
    );
    assert.equal(geometry.inside, true, label + " code glyph is not clipped");
    assert.equal(geometry.nowrap, "nowrap");
    await input.fill(label + " code " + width);
    await input.press("Control+a");
    await button.click();
    assert.equal(
      await input.evaluate((node) => node.value),
      "`" + label + " code " + width + "`",
    );
  }
  await input.press("Enter");
  await container
    .locator(".timeline .message-body code")
    .filter({ hasText: label + " code 390" })
    .waitFor();
}
async function mailbox() {
  return JSON.parse(await readFile("../../.cache/smtp-mails.json", "utf8"));
}
async function deliveredCode(since, address) {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const message of (await mailbox()).slice(since).reverse()) {
      const decoded = message
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      if (!decoded.includes(address)) continue;
      const code = /\b([0-9]{8})\b/.exec(decoded)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "No TLS SMTP verification receipt for the dedicated forms user",
  );
}
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  await page.goto(base);
  if (process.env.RV_WEB_EXPECT_ENTRY)
    assert.ok(
      await page
        .locator('script[type="module"][src]')
        .evaluateAll(
          (nodes, expected) =>
            nodes.some((node) =>
              new URL(node.src).pathname.endsWith("/" + expected),
            ),
          process.env.RV_WEB_EXPECT_ENTRY,
        ),
      "loads the expected application entry",
    );
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor({ timeout: 45000 });
  const directoryRequests = [];
  page.on("request", (request) => {
    if (
      ["/api/v1/users", "/api/v1/rooms/public"].includes(
        new URL(request.url()).pathname,
      )
    )
      directoryRequests.push(request);
  });
  let search = await spotlight();
  const query = search.getByLabel("Search people or channels", { exact: true });
  assert.equal(
    await query.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.waitForTimeout(350);
  assert.equal(
    directoryRequests.length,
    0,
    "empty spotlight does not list the whole directory",
  );
  const heldQuery = "gtk-absent-" + crypto.randomUUID();
  let release, entered;
  const barrier = new Promise((resolve) => (release = resolve)),
    reached = new Promise((resolve) => (entered = resolve));
  const heldRoute = "**/api/v1/rooms/public?q=" + heldQuery;
  await page.route(heldRoute, async (route) => {
    const response = await route.fetch();
    entered();
    await barrier;
    await route.fulfill({ response });
  });
  await query.fill(heldQuery);
  await reached;
  await query.fill(peerName);
  await search.locator('[data-user="' + peer.user.id + '"]').waitFor();
  const returned = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("q") === heldQuery,
  );
  release();
  await returned;
  await page.unroute(heldRoute);
  await search.locator('[data-user="' + peer.user.id + '"]').waitFor();
  assert.equal(
    await search.locator(".conversation-spotlight-status").isVisible(),
    false,
    "a delayed old empty answer cannot overwrite the current people result",
  );
  const beforeSearchCancel = creations.length;
  await page.keyboard.press("Escape");
  assert.equal(
    await query.inputValue(),
    "",
    "Escape first clears the native search entry",
  );
  await page.keyboard.press("Escape");
  await search.waitFor({ state: "detached" });
  assert.equal(
    creations.length,
    beforeSearchCancel,
    "search cancellation creates no room or direct message",
  );
  console.log(
    "PASS GTK spotlight focuses search, leaves empty directory unread, fences delayed answers and cancels without mutations",
  );

  const publicRoom = await api("/api/v1/rooms", peer.token, {
    name: peerName + " spotlight " + crypto.randomUUID().slice(0, 8),
    private: false,
    operation_id: crypto.randomUUID(),
  });
  search = await spotlight();
  await search
    .getByLabel("Search people or channels", { exact: true })
    .fill(peerName);
  const person = search.locator('[data-user="' + peer.user.id + '"]'),
    channel = search.locator('[data-room="' + publicRoom.id + '"]');
  await channel.waitFor();
  assert.equal(
    await person.evaluate(
      (node) => node === node.parentElement.firstElementChild,
    ),
    true,
    "native people results precede discovered channels",
  );
  assert.ok((await channel.textContent()).includes("Join"));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await search.evaluate((node) =>
        Math.round(node.getBoundingClientRect().height),
      ),
      480,
    );
    assert.equal(
      await person.evaluate((node) =>
        Math.round(node.getBoundingClientRect().height),
      ),
      55,
    );
    if (width === 390)
      assert.equal(
        await search.evaluate((node) =>
          Math.round(node.getBoundingClientRect().bottom),
        ),
        800,
      );
  }
  await page.screenshot({
    path: "../../.cache/web-shots/web-gtk-spotlight-narrow.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await channel.click();
  await search.waitFor({ state: "detached" });
  await page.waitForURL("**/room/" + publicRoom.id);
  assert.ok(
    (await api("/api/v1/rooms/" + publicRoom.id + "/read", me.token))
      .membership_version,
    "discovered channel opens only after real joining and personalized state",
  );
  search = await spotlight();
  await search
    .getByLabel("Search people or channels", { exact: true })
    .fill(peerName);
  await search.locator('[data-user="' + peer.user.id + '"]').click();
  await search.waitFor({ state: "detached" });
  const spotlightDirectId = new URL(page.url()).pathname.split("/").at(-1);
  await page
    .locator(
      '.room-row.selected[data-room="' +
        spotlightDirectId +
        '"]:not(:disabled)',
    )
    .waitFor();
  assert.equal(
    (await api("/api/v1/rooms/" + spotlightDirectId, me.token)).room.kind,
    "direct",
  );
  console.log(
    "PASS GTK spotlight preserves native desktop/narrow geometry, people-first results and real public join/direct-message navigation",
  );

  const before = creations.length;
  let dialog = await newConversation();
  const exact = dialog.getByLabel("Exact username", { exact: true }),
    roomName = dialog.getByLabel("Room name", { exact: true });
  assert.equal(
    await exact.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await dialog.locator(".preferences-group").count(), 2);
  for (const input of [exact, roomName]) {
    // Native empty EntryRows show their centred caption until activated.
    await input.locator("..").click();
    await input.fill("cancelled-field");
    await input.focus();
    const row = await input.evaluate((node) => {
      const row = node.closest(".entry-row"),
        title = row.querySelector(".action-row-title"),
        value = node.getBoundingClientRect(),
        caption = title.getBoundingClientRect(),
        bounds = row.getBoundingClientRect(),
        style = getComputedStyle(row);
      return {
        labelled: title.textContent === node.getAttribute("aria-label"),
        stacked: caption.bottom <= value.top + 1,
        inside:
          caption.left >= bounds.left &&
          value.left >= bounds.left &&
          caption.right <= bounds.right &&
          value.right <= bounds.right &&
          value.bottom <= bounds.bottom,
        focus:
          style.boxShadow !== "none" ||
          (style.outlineStyle !== "none" &&
            Number.parseFloat(style.outlineWidth) > 0),
        rounded: Number.parseFloat(style.borderRadius) > 0,
      };
    });
    assert.deepEqual(row, {
      labelled: true,
      stacked: true,
      inside: true,
      focus: true,
      rounded: true,
    });
  }
  await page.screenshot({
    path: "../../.cache/web-shots/web-gtk-form-focus.png",
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    creations.length,
    before,
    "Cancel leaves both room and direct-message creation untouched",
  );
  console.log(
    "PASS GTK EntryRow labels, unclipped rounded focus ring and inert cancellation",
  );

  dialog = await newConversation();
  assert.equal(
    await dialog
      .getByRole("switch", { name: "Private room", exact: true })
      .isChecked(),
    true,
  );
  const privateName = "gtk-private-" + crypto.randomUUID().slice(0, 8),
    created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/rooms",
    );
  await dialog.getByLabel("Room name", { exact: true }).locator("..").click();
  await dialog.getByLabel("Room name", { exact: true }).fill(privateName);
  await dialog
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  const creation = await created;
  assert.ok(creation.ok());
  const privateRoom = await creation.json();
  assert.equal(privateRoom.kind, "private");
  await dialog.waitFor({ state: "detached" });
  await page
    .locator('.room-row[data-room="' + privateRoom.id + '"]:not(:disabled)')
    .waitFor();
  assert.equal(
    (await api("/api/v1/rooms/" + privateRoom.id, me.token)).room.kind,
    "private",
  );
  dialog = await newConversation();
  await dialog.getByLabel("Exact username", { exact: true }).fill(peerName);
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/direct-messages",
  );
  await dialog.getByRole("button", { name: "Open a DM", exact: true }).click();
  const directResponse = await opened;
  assert.ok(directResponse.ok());
  const direct = await directResponse.json();
  assert.equal(direct.kind, "direct");
  await dialog.waitFor({ state: "detached" });
  await page.waitForURL("**/room/" + direct.id);
  assert.ok(
    (await api("/api/v1/rooms/" + direct.id + "/read", peer.token))
      .membership_version,
  );
  console.log(
    "PASS native private-room default and exact-user direct-message creation reach real memberships",
  );

  const room = await api("/api/v1/rooms", me.token, {
    name: "gtk-code-" + crypto.randomUUID().slice(0, 8),
    private: false,
    operation_id: crypto.randomUUID(),
  });
  const root = await api("/api/v1/rooms/" + room.id + "/messages", me.token, {
    text: "GTK formatting thread root",
    operation_id: crypto.randomUUID(),
  });
  await page.locator('.room-row[data-room="' + room.id + '"]').click();
  await page.waitForURL("**/room/" + room.id);
  await page
    .locator('.room-row.selected[data-room="' + room.id + '"]:not(:disabled)')
    .waitFor();
  await page.locator(".room-content .rich-composer").waitFor();
  await codeToolbar(page.locator(".room-content"), "Main");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('article[data-id="' + root.id + '"] .row-more').click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await page.locator(".thread-pane .rich-composer").waitFor();
  await codeToolbar(page.locator(".thread-pane"), "Thread");
  await page.screenshot({
    path: "../../.cache/web-shots/web-gtk-narrow-code-toolbar.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".thread-back").click();
  console.log(
    "PASS literal code glyph fits on one line and formats delivered messages in main/thread at wide/narrow sizes",
  );

  await settings();
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  const email = page.getByLabel("Email", { exact: true }),
    hint = "Verified address; change it in Security";
  assert.equal(await email.getAttribute("readonly"), "");
  assert.equal(await email.getAttribute("title"), hint);
  assert.equal(await email.locator("..").getAttribute("title"), hint);
  await email.focus();
  assert.equal(
    await email.evaluate((node) => getComputedStyle(node).caretColor),
    "rgba(0, 0, 0, 0)",
  );
  await page.locator(".preferences-back").click();
  await page
    .locator(".sidebar-categories")
    .getByRole("button", { name: "Security", exact: true })
    .click();
  const address = username + "@example.test",
    since = (await mailbox()).length,
    emailInput = page.getByLabel("New email address", { exact: true });
  assert.equal(await emailInput.getAttribute("type"), "email");
  assert.equal(await emailInput.getAttribute("readonly"), null);
  await emailInput.locator("..").click();
  await emailInput.fill(address);
  await page
    .getByRole("button", { name: "Send a verification code", exact: true })
    .click();
  await page.getByLabel("Email code (8 digits)", { exact: true }).waitFor();
  await page
    .getByLabel("Email code (8 digits)", { exact: true })
    .fill(await deliveredCode(since, address));
  await page
    .getByRole("button", { name: "Verify this address", exact: true })
    .click();
  await page
    .getByText("The address has been verified.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal((await api("/api/v1/me/email", me.token)).address, address);
  await page.locator(".preferences-close").click();
  await settings();
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  assert.equal(
    await page.getByLabel("Email", { exact: true }).inputValue(),
    address,
  );
  assert.equal(
    await page.getByLabel("Email", { exact: true }).getAttribute("readonly"),
    "",
  );
  console.log(
    "PASS readonly profile email directs editing to Security; real TLS SMTP verification refreshes the profile",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({
    path: "../../.cache/web-shots/gtk-forms-failure.png",
    mask: [
      page.locator(
        'input[type="password"],input[autocomplete="one-time-code"],.backup-codes,.totp-secret,.totp-qr',
      ),
    ],
  });
  throw error;
} finally {
  await browser.close();
}
