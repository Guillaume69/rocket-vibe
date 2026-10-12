import assert from "node:assert/strict";
import { fixture, closeDialog, groupDialog } from "./crypto-browser.mjs";

/** Real scoped references and sealed local search; no test plaintext injection. */
export async function privateQuoteSearch(page, bob, room, packets) {
  const tag = Date.now().toString(36),
    privateText = "Encrypted edited response",
    ordinaryText = "Ordinary quote source " + tag,
    privateReply = "Private reply to ordinary source " + tag,
    publicReply = "Ordinary reply to private source " + tag,
    peer = await fixture(bob, "/api/v1/me"),
    ordinary = await fixture(page, "/api/v1/rooms", "POST", {
      operation_id: crypto.randomUUID(),
      name: "quote-ordinary-" + tag,
      private: false,
    });
  await fixture(
    page,
    "/api/v1/rooms/" + ordinary.id + "/members/" + peer.id,
    "POST",
    null,
  );
  const input = (target) => target.locator(".room-content .rich-composer"),
    row = (target, text) =>
      target.locator(".room-content .timeline article").filter({
        has: target.locator(".message-body").getByText(text, { exact: true }),
      }),
    open = async (target, id) => {
      await target.locator('[data-room="' + id + '"]').click();
      await input(target).waitFor();
      await target.waitForFunction(
        () => !document.querySelector(".room-content .rich-composer")?.disabled,
      );
    },
    send = async (target, text, visible = text) => {
      await input(target).fill(text);
      await input(target).press("Enter");
      await row(target, visible).waitFor();
      await target.waitForFunction(
        () =>
          document
            .querySelector(".room-content .rich-composer")
            ?.getAttribute("aria-disabled") === "false",
      );
    },
    transfer = async (sourceText, destinationName) => {
      await row(page, sourceText).locator(".row-more").click();
      await page
        .locator(".actions-menu")
        .getByRole("button", {
          name: "Quote in another conversation",
          exact: true,
        })
        .click();
      const picker = page.locator(".quote-room-picker");
      await picker
        .getByLabel("Search people or channels")
        .fill(destinationName);
      await picker
        .getByRole("button", { name: destinationName, exact: true })
        .click();
      await picker.waitFor({ state: "detached" });
      await page.locator(".room-content .reply-bar:not([hidden])").waitFor();
    };
  const createPrivate = async (name) => {
    const created = await fixture(page, "/api/v1/rooms", "POST", {
      operation_id: crypto.randomUUID(),
      name,
      private: true,
    });
    await open(page, created.id);
    await groupDialog(page, created.id);
    await page
      .getByRole("button", {
        name: "Prepare this device for invitations",
        exact: true,
      })
      .click();
    await page
      .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
      .waitFor();
    await page
      .getByRole("button", { name: "Review group creation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm this review", exact: true })
      .click();
    await page
      .locator(".crypto-group-dialog")
      .getByText("Group recorded on this device", { exact: true })
      .waitFor();
    await closeDialog(page);
    await closeDialog(page);
    return created;
  };
  await open(page, ordinary.id);
  await send(page, ordinaryText);
  const privateName = (await fixture(page, "/api/v1/rooms/" + room)).room.name;
  await transfer(ordinaryText, privateName);
  await send(page, privateReply);
  await bob.locator(".quote-card").filter({ hasText: ordinaryText }).waitFor();
  assert.ok(
    !packets.some((packet) => packet.includes(privateReply)),
    "Private reply authoring sends only MLS ciphertext",
  );
  await transfer(privateText, ordinary.name);
  await send(page, publicReply);
  await row(page, publicReply)
    .locator(".quote-card")
    .filter({ hasText: privateText })
    .waitFor();
  await open(bob, ordinary.id);
  await row(bob, publicReply)
    .locator(".quote-card")
    .filter({ hasText: privateText })
    .waitFor();
  const receipt = (
    await fixture(page, "/api/v1/rooms/" + ordinary.id + "/messages")
  ).messages.find((message) => message.text === publicReply);
  assert.ok(
    receipt.quotes.length === 1 && receipt.quotes[0].reference.room_id === room,
  );
  assert.equal(
    receipt.quotes[0].excerpt,
    null,
    "The ordinary API never returns a private source excerpt",
  );
  assert.ok(
    !packets.some((packet) => packet.includes(privateText)),
    "Private source words never enter ordinary authoring HTTP",
  );
  console.log(
    "PASS GTK ordinary→private and private→ordinary scoped quotes, protected volatile excerpts and reference-only authoring",
  );

  // A separate owner-only MLS destination qualifies the third direction without
  // replacing the main group's admission used by voice and recovery below.
  const destination = await createPrivate("quote-private-" + tag);
  await open(page, room);
  await transfer(privateText, destination.name);
  await send(page, "Private cross-room reply " + tag);
  await row(page, "Private cross-room reply " + tag)
    .locator(".quote-card")
    .filter({ hasText: privateText })
    .waitFor();
  const isolatedText = "Isolated private source " + tag;
  await send(page, isolatedText);
  await transfer(isolatedText, ordinary.name);
  await send(page, "Reader-scoped private quote " + tag);
  await row(page, "Reader-scoped private quote " + tag)
    .locator(".quote-card")
    .filter({ hasText: isolatedText })
    .waitFor();
  await row(bob, "Reader-scoped private quote " + tag)
    .locator(".quote-card")
    .waitFor();
  assert.equal(
    await row(bob, "Reader-scoped private quote " + tag)
      .locator(".quote-card")
      .textContent(),
    "Quote unavailable",
    "A member without the source MLS admission cannot see its private words",
  );
  console.log(
    "PASS GTK private→private quotation and private-source isolation for an ordinary-room reader without admission",
  );
  await open(page, room);
  await transfer("Private quoted message", ordinary.name);
  await send(page, "Nested ordinary quote " + tag);
  const nested = row(page, "Nested ordinary quote " + tag).locator(
    ".quote-card .quote-card",
  );
  await nested.filter({ hasText: privateText }).waitFor();
  assert.equal(
    await nested.count(),
    1,
    "Native quote cards retain exactly two levels",
  );
  await open(page, room);
  await transfer("Private attachment", ordinary.name);
  await send(page, "Quoted encrypted attachment " + tag);
  const sealedFileQuote = row(
    page,
    "Quoted encrypted attachment " + tag,
  ).locator(".quote-card");
  assert.equal(
    await sealedFileQuote.locator(".file-card,.image-card,.quote-file").count(),
    0,
    "GTK reference cards do not acquire public metadata for encrypted source files",
  );
  assert.ok(
    !(await sealedFileQuote.textContent()).includes("private-note.txt"),
  );
  const upload = async (file, text, visible = text) => {
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Attach a file", exact: true })
      .click();
    await (await chooser).setFiles(file);
    await send(page, text, visible);
    await row(page, visible).locator(".pending").waitFor({ state: "detached" });
  };
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#39e1cf";
    context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await upload(
    {
      name: "quote-image.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    },
    "Ordinary *formatted quote* " + tag,
    "Ordinary formatted quote " + tag,
  );
  await transfer("Ordinary formatted quote " + tag, privateName);
  await send(page, "Quoted ordinary image " + tag);
  const imageQuote = row(page, "Quoted ordinary image " + tag).locator(
    ".quote-card",
  );
  await imageQuote
    .locator("strong")
    .getByText("formatted quote", { exact: true })
    .waitFor();
  await imageQuote.locator(".image-frame img").waitFor();
  assert.equal(
    await imageQuote
      .locator(".image-frame img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  await open(page, ordinary.id);
  await upload(
    {
      name: "quote-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Ordinary quote file " + tag),
    },
    "Ordinary quoted file " + tag,
  );
  await transfer("Ordinary quoted file " + tag, privateName);
  await send(page, "Quoted ordinary file " + tag);
  const fileQuote = row(page, "Quoted ordinary file " + tag).locator(
    ".quote-card",
  );
  await fileQuote
    .locator(".quote-file")
    .getByText("quote-note.txt", { exact: true })
    .waitFor();
  assert.equal(
    await fileQuote.locator(".file-download-trigger,.file-action").count(),
    0,
    "Native quoted ordinary files are passive labels",
  );
  assert.ok(
    !packets.some((packet) => packet.includes(isolatedText)),
    "Nested/private-file quote authoring carries no private source words over HTTP",
  );
  console.log(
    "PASS GTK passive Markdown, two-level nested quotes and protected ordinary image/file presentation without encrypted-file metadata leakage",
  );

  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rocket-vibe-web");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return JSON.stringify(
        await Promise.all(
          ["cache", "drafts", "outbox", "uploads", "staged"].map(
            (name) =>
              new Promise((resolve, reject) => {
                const request = db.transaction(name).objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              }),
          ),
        ),
      );
    } finally {
      db.close();
    }
  });
  assert.ok(
    !stored.includes(privateText) && !stored.includes(isolatedText),
    "Private quote overlays never enter ordinary IndexedDB",
  );
  await fixture(
    page,
    "/api/v1/rooms/" + ordinary.id + "/members/" + peer.id,
    "DELETE",
  );
  await open(bob, room);
  const withdrawn = row(bob, privateReply).locator(".quote-card");
  await bob.waitForFunction(
    (text) => {
      const row = [...document.querySelectorAll(".timeline article")].find(
        (row) => row.querySelector(".message-body")?.textContent === text,
      );
      return (
        row?.querySelector(".quote-card")?.textContent === "Quote unavailable"
      );
    },
    privateReply,
    { timeout: 30000 },
  );
  assert.equal(await withdrawn.textContent(), "Quote unavailable");
  console.log(
    "PASS ordinary-source withdrawal masks an existing private quote without replacing the main MLS admission",
  );

  // The selected result is older than the rendered native 200-row page after
  // reload; navigation must page the sealed journal rather than insert a hit
  // in the ordinary Model or ask an ordinary server message endpoint.
  const history = await createPrivate("search-private-" + tag);
  const oldestText = "Retained private search target " + tag;
  await send(page, oldestText);
  const threadText = "Retained private thread search target " + tag;
  await row(page, oldestText).locator(".row-more").click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await page.locator(".thread-pane .rich-composer").fill(threadText);
  await page.locator(".thread-pane .rich-composer").press("Enter");
  await page
    .locator(".thread-pane .message-body")
    .getByText(threadText, { exact: true })
    .waitFor();
  await page.locator(".thread-pane .thread-back").click();
  for (let index = 0; index < 205; index++) {
    await send(page, "Private history filler " + tag + " " + index);
    if ((index + 1) % 50 === 0)
      console.log(
        "Seeded " + (index + 1) + " accepted private search history messages",
      );
  }
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator(".timeline .message-body")
    .getByText("Private history filler " + tag + " 204", { exact: true })
    .waitFor();
  assert.equal(
    await row(page, oldestText).count(),
    0,
    "The retained target starts outside the rendered page",
  );
  const searchRequests = [];
  const record = (request) => {
    if (
      request.url().includes("/api/v1/rooms/" + history.id + "/messages/search")
    )
      searchRequests.push(request.url());
  };
  page.on("request", record);
  await page
    .getByRole("button", { name: "Search in room", exact: true })
    .click();
  await page
    .locator(".room-search-dialog")
    .getByRole("searchbox")
    .fill(oldestText);
  const hit = page
    .locator(".search-results .conversation-preview")
    .filter({ hasText: oldestText });
  await hit.waitFor();
  assert.equal(
    await hit.locator(".row-more,.quick-reactions").count(),
    0,
    "GTK search results are compact navigation rows",
  );
  await hit.click();
  await row(page, oldestText).waitFor();
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".timeline article")].some(
        (node) =>
          node.classList.contains("jump-highlight") &&
          node.querySelector(".message-body")?.textContent === text,
      ),
    oldestText,
  );
  assert.equal(await page.locator(".room-search-dialog[open]").count(), 0);
  assert.equal(
    searchRequests.length,
    0,
    "Private search never sends a text query to the server",
  );
  page.off("request", record);
  console.log(
    "PASS older retained private search results navigate and highlight through sealed history without ordinary search HTTP",
  );

  // Existing thread hits open their root while preserving sealed thread drafts.
  await page
    .getByRole("button", { name: "Search in room", exact: true })
    .click();
  await page
    .locator(".room-search-dialog")
    .getByRole("searchbox")
    .fill(threadText);
  await page
    .locator(".search-results .conversation-preview")
    .filter({ hasText: threadText })
    .click();
  await page
    .locator(".thread-pane .message-body")
    .getByText(threadText, { exact: true })
    .waitFor();
  await page.locator(".thread-pane .thread-back").click();
  console.log(
    "PASS private thread search results open the protected root and retained reply",
  );
  await open(page, room);
}
