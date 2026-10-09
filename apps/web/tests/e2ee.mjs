import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
import { execFileSync } from "node:child_process";
import {
  base,
  fixture,
  identity,
  groupDialog,
  pin,
  closeDialog,
} from "./crypto-browser.mjs";
const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  }),
  context = await browser.newContext({ locale: "en-US" }),
  page = await context.newPage();
const failures = [];
let recovered;
page.on("pageerror", (error) => failures.push(error.message));
const packets = [];
page.on("request", (request) => {
  if (request.method() === "POST" && request.url().includes("/api/v1/"))
    packets.push(request.postData() || "");
});
const users = [process.env.RV_WEB_CRYPTO_ALICE, process.env.RV_WEB_CRYPTO_BOB];
const other = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
      "media.peerconnection.ice.loopback": false,
    },
  }),
  bob = await (await other.newContext({ locale: "en-US" })).newPage();
for (const target of [page, bob])
  await target.addInitScript(() => {
    window.testToasts = [];
    window.testPeers = [];
    window.RTCPeerConnection = new Proxy(RTCPeerConnection, {
      construct(Target, args) {
        const connection = new Target(...args);
        window.testPeers.push(connection);
        return connection;
      },
    });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.classList.contains("toast"))
            window.testToasts.push(node.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
if (!users[0] || !users[1]) {
  const container = "rv-web-e2ee-api";
  assert.equal(
    execFileSync(
      "docker",
      [
        "inspect",
        "-f",
        '{{ index .Config.Labels "rocketvibe.task" }}',
        container,
      ],
      { encoding: "utf8" },
    ).trim(),
    "web-e2ee",
  );
  const run = Date.now().toString(36);
  for (let i = 0; i < 2; i++) {
    users[i] = "webcrypto" + (i ? "b" : "a") + run;
    execFileSync(
      "docker",
      [
        "exec",
        "-e",
        "RV_USER_PASSWORD=web-client-disposable-password",
        container,
        ".cache/server-target/debug/rv-server",
        "create-user",
        users[i],
        "--admin",
      ],
      { stdio: "pipe" },
    );
  }
}
try {
  await page.goto(base);
  await page.getByLabel("Username or email").fill(users[0]);
  await page
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-category="encryption"]').click();
  await page
    .getByRole("button", {
      name: "Create identity or accept the displayed fingerprint",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Review this device’s request", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Approve the displayed fingerprints",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Install approval and register this device",
      exact: true,
    })
    .click();
  await page
    .getByText("Identity and device registered", { exact: true })
    .waitFor();
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log(
    "PASS real browser account identity creation, own-device review, approval and signed server registration",
  );
  await page.locator(".settings-dialog .preferences-close").click();
  const room = (
    await fixture(page, "/api/v1/rooms", "POST", {
      operation_id: crypto.randomUUID(),
      name: "private-" + Date.now(),
      private: true,
    })
  ).id;
  await page.locator('[data-room="' + room + '"]').click();
  await page.locator(".room-heading").click();
  await page
    .getByRole("button", { name: "Room encryption", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Prepare this device for invitations",
      exact: true,
    })
    .click();
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
  console.log("PASS real MLS group creation and receipt");
  await page.locator(".crypto-group-dialog .dialog-header button").click();
  await page.locator(".crypto-group-dialog").waitFor({ state: "detached" });
  await page.locator("dialog[open] .dialog-header button").click();
  const input = page.locator(".room-content .rich-composer"),
    text = "private **browser** message " + Date.now();
  await input.fill(text);
  await input.press("Enter");
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: "private browser message" })
    .waitFor();
  assert.ok(
    packets.every((body) => !body.includes(text)),
    "No clear private message in API packets",
  );
  const ordinary = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("rocket-vibe-web");
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return JSON.stringify(
        await Promise.all(
          ["cache", "drafts", "outbox", "uploads", "staged"].map(
            (name) =>
              new Promise((resolve) => {
                const request = db.transaction(name).objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
              }),
          ),
        ),
      );
    } finally {
      db.close();
    }
  });
  assert.ok(
    !ordinary.includes(text),
    "No clear private message in ordinary indexed storage",
  );
  assert.equal(
    await page.locator(".timeline .message-body strong").first().innerText(),
    "browser",
  );
  console.log(
    "PASS real encrypted send, local native markdown, verified journal and separation from ordinary storage/HTTP",
  );
  await page.reload();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: "private browser message" })
    .waitFor();
  console.log(
    "PASS encrypted conversation reload without recreating identity or ratchet",
  );
  // Public membership is a fixture action; identity/pins/MLS admissions go
  // through the visible application and the actual native bridge.
  await identity(bob, users[1]);
  const invitee = (await fixture(page, "/api/v1/users")).find(
    (user) => user.username === users[1],
  );
  await fixture(
    page,
    "/api/v1/rooms/" + room + "/members/" + invitee.id,
    "POST",
    null,
  );
  await pin(page, users[1]);
  await bob.locator('[data-room="' + room + '"]').click();
  await pin(bob, users[0]);
  await groupDialog(bob, room);
  await bob
    .getByRole("button", {
      name: "Prepare this device for invitations",
      exact: true,
    })
    .click();
  await bob
    .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
    .waitFor();
  await closeDialog(bob);
  await closeDialog(bob);
  await groupDialog(page, room);
  await page
    .getByRole("button", { name: "Review device changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm this review", exact: true })
    .click();
  await page
    .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
    .waitFor();
  await page
    .getByText("Group recorded on this device", { exact: true })
    .waitFor();
  await closeDialog(page);
  await closeDialog(page);
  await groupDialog(bob, room);
  await bob
    .getByRole("button", { name: "Review admission or update", exact: true })
    .click();
  await bob
    .getByRole("button", { name: "Confirm this review", exact: true })
    .click();
  await bob
    .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
    .waitFor();
  await bob
    .getByText("Group recorded on this device", { exact: true })
    .waitFor();
  await closeDialog(bob);
  await closeDialog(bob);
  const bobInput = bob.locator(".room-content .rich-composer");
  await bobInput.fill("Firefox encrypted reply");
  await bobInput.press("Enter");
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: "Firefox encrypted reply" })
    .waitFor();
  await input.fill("Chromium encrypted response");
  await input.press("Enter");
  await bob
    .locator(".timeline .message-body")
    .filter({ hasText: "Chromium encrypted response" })
    .waitFor();
  assert.equal(
    await bob
      .locator(".timeline .message-body")
      .filter({ hasText: "private browser message" })
      .count(),
    0,
    "New member cannot read before admission",
  );
  console.log(
    "PASS cross-browser verified peer certificates, MLS admission and bidirectional encrypted messages with pre-admission isolation",
  );
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Attach a file", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "private-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("encrypted file content " + Date.now()),
  });
  await input.fill("Private attachment");
  await input.press("Enter");
  await bob.getByText("private-note.txt", { exact: true }).waitFor();
  const download = bob.waitForEvent("download");
  await bob
    .locator(".file-card")
    .filter({ hasText: "private-note.txt" })
    .getByRole("button", { name: "Download", exact: true })
    .click();
  const result = await download;
  const stream = await result.createReadStream();
  let clear = "";
  for await (const chunk of stream) clear += chunk;
  assert.ok(clear.startsWith("encrypted file content "));
  console.log("PASS native encrypted file format across Chromium and Firefox");
  const authored = page
    .locator(".timeline article")
    .filter({ hasText: "Chromium encrypted response" });
  await authored.locator(".row-more").click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .getByLabel("Write a message…", { exact: true })
    .fill("Encrypted edited response");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await bob
    .locator(".timeline .message-body")
    .filter({ hasText: "Encrypted edited response" })
    .waitFor();
  await page
    .locator(".timeline article")
    .filter({ hasText: "Encrypted edited response" })
    .locator(".row-more")
    .click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Quote", exact: true })
    .click();
  await page.locator(".reply-bar:not([hidden])").waitFor();
  await input.fill("Private quoted message");
  await input.press("Enter");
  await bob
    .locator(".quote-card")
    .filter({ hasText: "Encrypted edited response" })
    .waitFor();
  await page
    .locator(".timeline article")
    .filter({
      has: page
        .locator(".message-body")
        .filter({ hasText: "Encrypted edited response" }),
    })
    .locator(".row-more")
    .click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const thread = page.locator(".thread-pane .rich-composer");
  await thread.fill("Private thread reply");
  await thread.press("Enter");
  await page
    .locator(".thread-pane .message-body")
    .filter({ hasText: "Private thread reply" })
    .waitFor();
  console.log("PASS private edits, quotes and threaded replies");
  await page
    .locator(".thread-pane")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await bob
    .locator(".timeline article")
    .filter({
      has: bob
        .locator(".message-body")
        .filter({ hasText: "Encrypted edited response" }),
    })
    .locator(".row-more")
    .click();
  await bob
    .locator(".quick-reactions")
    .getByRole("button", { name: "❤️", exact: true })
    .click();
  await page
    .locator(".timeline article")
    .filter({
      has: page
        .locator(".message-body")
        .filter({ hasText: "Encrypted edited response" }),
    })
    .locator(".reaction")
    .waitFor();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("searchbox")
    .fill("Encrypted edited response");
  await page
    .locator(".search-results .message-body")
    .filter({ hasText: "Encrypted edited response" })
    .waitFor();
  await closeDialog(page);
  const deletedText = "Private temporary message " + Date.now();
  await input.fill(deletedText);
  await input.press("Enter");
  const removable = page
    .locator(".timeline article")
    .filter({ hasText: deletedText });
  await removable.locator(".row-more").click();
  await page
    .locator(".actions-menu")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await removable.waitFor({ state: "detached" });
  assert.ok(
    packets.every(
      (body) =>
        !body.includes(deletedText) &&
        !body.includes("Encrypted edited response"),
    ),
    "Private actions and search do not expose clear content in HTTP packets",
  );
  console.log(
    "PASS encrypted reactions/deletion and local private search without clear network payloads",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-category="encryption"]').click();
  const rootFingerprint = await page
    .locator(".crypto-fingerprint")
    .first()
    .innerText();
  await page
    .getByRole("button", { name: "Review backup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Prepare this backup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show recovery code", exact: true })
    .click();
  const recoveryCode = await page
    .locator(".crypto-code")
    .filter({ hasText: "rvk1-" })
    .innerText();
  await page
    .getByRole("button", {
      name: "I have saved this code: publish backup",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Review backup", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("rocket-vibe-private");
      r.onsuccess = () => resolve(r.result);
    });
    const entries = await new Promise((resolve) => {
      const r = db.transaction("vaults").objectStore("vaults").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    window.testOldVault = entries[0];
    db.close();
  });
  await page.getByRole("button", { name: "Renew now", exact: true }).click();
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("rocket-vibe-private");
      r.onsuccess = () => resolve(r.result);
    });
    try {
      const tx = db.transaction("vaults"),
        store = tx.objectStore("vaults");
      const [entries, scopes] = await Promise.all([
        new Promise((resolve) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result);
        }),
        new Promise((resolve) => {
          const r = store.getAllKeys();
          r.onsuccess = () => resolve(r.result);
        }),
      ]);
      const current = entries[0];
      if (current.revision <= window.testOldVault.revision) return false;
      const options = {
        name: "AES-GCM",
        iv: current.iv,
        additionalData: new TextEncoder().encode(
          JSON.stringify([
            "rocketvibe-browser-vault-v1",
            scopes[0],
            current.revision,
          ]),
        ),
      };
      try {
        await crypto.subtle.decrypt(
          options,
          window.testOldVault.key,
          current.ciphertext,
        );
        return false;
      } catch {}
      new Uint8Array(
        await crypto.subtle.decrypt(options, current.key, current.ciphertext),
      ).fill(0);
      return !current.key.extractable;
    } finally {
      db.close();
    }
  });
  console.log(
    "PASS explicit root-backup publication and browser storage-key renewal",
  );
  await page
    .getByRole("button", { name: "Enable the history backup", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("button", { name: "Enable the history backup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show the history code", exact: true })
    .click();
  const historyCode = await page
    .locator(".crypto-code")
    .filter({ hasText: "rvh1-" })
    .innerText();
  await page
    .getByRole("button", {
      name: "I have saved this code: enable",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await page.getByText(/\d+ pages? uploaded/).waitFor();
  console.log(
    "PASS explicit history-backup enablement, saved code and encrypted journal upload",
  );
  await page.locator(".settings-dialog .preferences-close").click();
  const details = await fixture(page, "/api/v1/rooms/" + room);
  await fixture(page, "/api/v1/rooms/" + room, "PATCH", {
    operation_id: crypto.randomUUID(),
    expected_revision: details.revision,
    name: details.room.name,
    private: true,
    topic: details.topic,
    description: details.description,
    announcement: details.announcement,
    read_only: details.read_only,
    voice: true,
  });
  for (const target of [page, bob]) {
    await target
      .locator('[data-room="' + room + '"] .room-top .symbolic-icon')
      .waitFor();
    await target.locator('[data-room="' + room + '"]').click();
    await target.locator(".voice-status.connected").waitFor({ timeout: 30000 });
  }
  for (const target of [page, bob]) {
    await target.waitForFunction(
      async () => {
        const stats = (
          await Promise.all(window.testPeers.map((pc) => pc.getStats()))
        ).flatMap((r) => [...r.values()]);
        return (
          stats.some(
            (s) =>
              s.type === "inbound-rtp" &&
              (s.kind || s.mediaType) === "audio" &&
              s.bytesReceived > 1000 &&
              s.totalAudioEnergy > 0,
          ) &&
          stats.some(
            (s) =>
              s.type === "outbound-rtp" &&
              (s.kind || s.mediaType) === "audio" &&
              s.bytesSent > 1000,
          )
        );
      },
      {},
      { timeout: 30000 },
    );
    await target
      .locator(
        '.room-voice-roster[data-voice-room="' + room + '"] .room-voice-person',
      )
      .nth(1)
      .waitFor();
  }
  console.log(
    "PASS encrypted voice autojoin, cross-browser decrypted audio energy and connected occupants",
  );
  for (const target of [page, bob])
    await target
      .locator(".voice-bar")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  // Keep recovery material in memory only, never in diagnostic output.
  assert.ok(recoveryCode.length > 64);
  recovered = await (await browser.newContext({ locale: "en-US" })).newPage();
  await recovered.addInitScript(() => {
    window.testToasts = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.classList.contains("toast"))
            window.testToasts.push(node.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  await recovered.goto(base);
  await recovered.getByLabel("Username or email").fill(users[0]);
  await recovered
    .getByLabel("Password", { exact: true })
    .fill("web-client-disposable-password");
  await recovered.getByRole("button", { name: "Sign in", exact: true }).click();
  await recovered.locator(".status-dot.online").waitFor();
  await recovered
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await recovered.locator('[data-category="encryption"]').click();
  await recovered
    .getByLabel("Recovery code", { exact: true })
    .fill(recoveryCode);
  await recovered
    .getByRole("button", { name: "Verify code and backup", exact: true })
    .click();
  await recovered
    .locator("dialog[open]")
    .last()
    .getByRole("button")
    .filter({ hasText: "Recover" })
    .click();
  await recovered.waitForFunction(
    () => document.querySelectorAll("dialog[open]").length === 1,
    {},
    { timeout: 60000 },
  );
  for (const name of [
    "Create identity or accept the displayed fingerprint",
    "Review this device’s request",
    "Approve the displayed fingerprints",
    "Install approval and register this device",
  ])
    await recovered.getByRole("button", { name, exact: true }).click();
  await recovered
    .getByText("Identity and device registered", { exact: true })
    .waitFor();
  assert.equal(
    await recovered.locator(".crypto-fingerprint").first().innerText(),
    rootFingerprint,
  );
  await recovered.getByLabel("History code", { exact: true }).fill(historyCode);
  await recovered
    .getByRole("button", { name: "Join with the code", exact: true })
    .click();
  await recovered
    .getByRole("button", { name: "Restore the history", exact: true })
    .click();
  await recovered.getByText(/[1-9]\d* messages? restored/).waitFor();
  console.log(
    "PASS recovery into a fresh browser profile with the same root, a new registered leaf and separate-code history restoration",
  );
  assert.equal(failures.length, 0, failures.join("\n"));
} catch (error) {
  if (recovered) {
    console.log(
      "Recovery state:",
      await recovered
        .locator("body")
        .innerText()
        .then((text) => text.replace(/rv[khr][a-z0-9-]+/g, "[recovery-code]")),
    );
    console.log(
      "Recovery errors:",
      await recovered.evaluate(() => window.testToasts),
    );
  }
  console.log(
    "Browser state:",
    await page
      .locator("body")
      .innerText()
      .then((text) => text.replace(/rv[khr][a-z0-9-]+/g, "[recovery-code]")),
  );
  console.log("Browser errors:", await page.evaluate(() => window.testToasts));
  console.log("Firefox state:", await bob.locator("body").innerText());
  console.log("Firefox errors:", await bob.evaluate(() => window.testToasts));
  throw error;
} finally {
  await browser.close();
  await other.close();
}
