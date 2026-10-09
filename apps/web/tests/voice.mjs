import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const aliceName = process.env.RV_WEB_ALICE || "webalice";
const bobName = process.env.RV_WEB_BOB || "webbob";
const password = "web-client-disposable-password";
const request = async (path, token, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
const discovery = await request("/.well-known/rocketvibe");
assert.equal(
  discovery.capabilities.voice,
  true,
  "Configure the isolated LiveKit bench before this test",
);
const alice = await request("/api/v1/auth/login", null, {
    username: aliceName,
    password,
  }),
  bob = await request("/api/v1/auth/login", null, {
    username: bobName,
    password,
  });
const room = await request("/api/v1/rooms", alice.token, {
  name: "voice-" + crypto.randomUUID().slice(0, 8),
  private: false,
  voice: true,
  operation_id: crypto.randomUUID(),
});
await request(
  "/api/v1/rooms/" + room.id + "/members/" + bob.user.id,
  alice.token,
  null,
);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const contexts = [];
const pages = [];
try {
  for (const username of [aliceName, bobName]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ["microphone", "camera"],
      locale: "en-US",
    });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__voiceGains = [];
      const create = BaseAudioContext.prototype.createGain;
      BaseAudioContext.prototype.createGain = function (...args) {
        const node = create.apply(this, args);
        window.__voiceGains.push(node);
        return node;
      };
    });
    const page = await context.newPage();
    pages.push(page);
    await page.goto(base);
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".shell").waitFor();
    await page
      .locator('[data-room="' + room.id + '"]')
      .first()
      .click();
    await page.locator(".voice-page").waitFor({ timeout: 30000 });
  }
  const [a, b] = pages;
  await a.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".voice-stage audio")).some(
        (audio) => audio.srcObject?.getAudioTracks().length,
      ),
    {},
    { timeout: 30000 },
  );
  await b.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".voice-stage audio")).some(
        (audio) => audio.srcObject?.getAudioTracks().length,
      ),
    {},
    { timeout: 30000 },
  );
  console.log(
    "PASS two browser participants exchange real WebRTC microphone tracks through LiveKit",
  );
  await a.locator(".voice-status.connected").waitFor();
  assert.equal(
    await a
      .locator(
        ".voice-controls .voice-control,.voice-controls .voice-menu-button",
      )
      .count(),
    6,
  );
  await a.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".voice-card")].map((card) =>
      card.getBoundingClientRect(),
    );
    return (
      cards.length === 2 &&
      cards.every(
        (card) =>
          card.width / card.height > 1.77 && card.width / card.height < 1.79,
      ) &&
      Math.abs(cards[0].left - cards[1].left) < 1 &&
      cards[1].top > cards[0].bottom
    );
  });
  await a.getByRole("button", { name: "Open the chat", exact: true }).click();
  await a.locator(".voice-page").waitFor({ state: "hidden" });
  await a.locator(".voice-bar-info").click();
  await a.locator(".voice-page").waitFor();
  console.log(
    "PASS GTK call header, six controls and centered 16:9 tiles with chat navigation",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Audio options", exact: true })
    .click();
  const audioMenu = a.getByRole("dialog", {
    name: "Audio options",
    exact: true,
  });
  await audioMenu.getByLabel("Output volume", { exact: true }).waitFor();
  const setRange = async (locator, value) =>
    locator.evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  await setRange(audioMenu.getByLabel("Input volume", { exact: true }), 40);
  await a.waitForFunction(() =>
    window.__voiceGains.some((node) => Math.abs(node.gain.value - 0.4) < 0.005),
  );
  await setRange(audioMenu.getByLabel("Output volume", { exact: true }), 125);
  await a.waitForFunction(() =>
    window.__voiceGains.some(
      (node) => Math.abs(node.gain.value - 1.25) < 0.005,
    ),
  );
  assert.equal(
    await audioMenu.getByRole("meter").getAttribute("aria-valuemax"),
    "100",
  );
  await a.keyboard.press("Escape");
  await audioMenu.waitFor({ state: "detached" });
  const peer = a.locator('[data-participant="' + bob.user.id + '"]');
  await peer.click({ button: "right" });
  const personMenu = a.getByRole("dialog", {
    name: bob.user.display_name || bob.user.username,
    exact: true,
  });
  await setRange(personMenu.getByLabel("User volume", { exact: true }), 150);
  await a.waitForFunction(() =>
    window.__voiceGains.some(
      (node) => Math.abs(node.gain.value - 1.875) < 0.005,
    ),
  );
  await personMenu.getByLabel("Mute for me", { exact: true }).check();
  await a.waitForFunction(() =>
    window.__voiceGains.some((node) => node.gain.value === 0),
  );
  await peer.locator(".voice-muted-here").waitFor();
  const mutedState = await request("/api/v1/live", alice.token);
  assert.equal(
    mutedState.data.rooms
      .find((item) => item.room_id === room.id)
      .voice.find((item) => item.user.id === bob.user.id).muted,
    false,
    "local mute must not mute the other participant for the room",
  );
  await personMenu.getByLabel("Mute for me", { exact: true }).uncheck();
  await a.waitForFunction(() =>
    window.__voiceGains.some(
      (node) => Math.abs(node.gain.value - 1.875) < 0.005,
    ),
  );
  await a.keyboard.press("Escape");
  console.log(
    "PASS microphone gain, 200 percent output/person volume and local-only mute affect actual Web Audio nodes",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Listen", exact: true })
    .click();
  await a.waitForFunction(() =>
    window.__voiceGains.some((node) => node.gain.value === 0),
  );
  await b
    .locator(
      '[data-participant="' + alice.user.id + '"] .voice-media .voice-deafened',
    )
    .waitFor();
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Listen", exact: true })
    .click();
  await a.waitForFunction(() =>
    window.__voiceGains.some(
      (node) => Math.abs(node.gain.value - 1.875) < 0.005,
    ),
  );
  console.log(
    "PASS deafen silences playback, announces the state and restores the individual mix",
  );
  let releaseClaim, claimReady;
  const claimed = new Promise((resolve) => (claimReady = resolve));
  await a.route("**/api/v1/voice/screen", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 204);
    releaseClaim = () => route.fulfill({ response });
    claimReady();
  });
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  await claimed;
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-page").waitFor({ state: "detached" });
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await releaseClaim();
  await a.locator(".voice-page").waitFor();
  await a.locator(".voice-status.connected").waitFor();
  await a.unroute("**/api/v1/voice/screen");
  let afterShare;
  for (let attempt = 0; attempt < 50; attempt++) {
    const live = await request("/api/v1/live", alice.token);
    afterShare = live.data.rooms
      .find((item) => item.room_id === room.id)
      ?.voice?.find((item) => item.user.id === alice.user.id);
    if (afterShare) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(afterShare, "rejoined participant must reach the server roster");
  assert.equal(Boolean(afterShare.screen), false);
  console.log(
    "PASS a delayed screen claim cannot capture or retain a share after leaving and rejoining",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Camera", exact: true })
    .click();
  await b.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".voice-stage video")).some(
        (video) =>
          video.srcObject
            ?.getVideoTracks()
            .some((track) => track.readyState === "live"),
      ),
    {},
    { timeout: 30000 },
  );
  console.log("PASS browser camera reaches the other participant");
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await a.waitForFunction(() =>
    document.querySelector(
      '.voice-controls [aria-label="Microphone"][aria-pressed="true"]',
    ),
  );
  console.log("PASS microphone mute control");
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await a.locator(".voice-page").waitFor();
  await a
    .locator('[data-participant="' + bob.user.id + '"]')
    .click({ button: "right" });
  const restored = a.getByRole("dialog", {
    name: bob.user.display_name || bob.user.username,
    exact: true,
  });
  assert.equal(
    await restored.getByLabel("User volume", { exact: true }).inputValue(),
    "150",
  );
  await a.keyboard.press("Escape");
  console.log(
    "PASS leave and rejoin with fresh media resources and restored individual volumes",
  );
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await b
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const direct = await request("/api/v1/direct-messages", alice.token, {
    user_id: bob.user.id,
  });
  for (const page of [a, b])
    await page
      .locator('[data-room="' + direct.id + '"]')
      .first()
      .click();
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  const incoming = b.locator("dialog").filter({
    has: b.getByRole("heading", { name: "Incoming call", exact: true }),
  });
  await incoming.waitFor();
  await incoming.getByRole("button", { name: "Accept", exact: true }).click();
  await a.locator(".voice-page").waitFor();
  await b.locator(".voice-page").waitFor();
  await a.waitForFunction(() =>
    [...document.querySelectorAll(".voice-stage audio")].some(
      (audio) => audio.srcObject?.getAudioTracks().length,
    ),
  );
  console.log(
    "PASS direct call rings the other browser and acceptance exchanges actual audio",
  );
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await a.locator(".voice-status.connected").waitFor();
  await a.waitForFunction(() =>
    [...document.querySelectorAll(".voice-stage audio")].some((audio) =>
      audio.srcObject
        ?.getAudioTracks()
        .some((track) => track.readyState === "live"),
    ),
  );
  assert.equal(await b.locator(".voice-page").isVisible(), true);
  console.log(
    "PASS direct calls keep the GTK two-second grace when the peer rejoins",
  );
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await b.locator(".voice-bar").waitFor({ state: "detached" });
  console.log(
    "PASS the remaining direct-call participant hangs up automatically",
  );
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await incoming.waitFor();
  await incoming.getByRole("button", { name: "Decline", exact: true }).click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  assert.equal(await a.locator(".voice-page").count(), 0);
  console.log(
    "PASS declining a direct call stops the caller without creating a media session",
  );
  let releaseAcceptance, accepted, completed;
  let deliveryError;
  const delivered = new Promise((resolve) => {
    completed = resolve;
  });
  const committed = new Promise((resolve) => {
    accepted = resolve;
  });
  await b.route("**/api/v1/voice/rings/*/accept", async (route) => {
    const response = await route.fetch();
    assert.ok(response.ok());
    await new Promise((resolve) => {
      releaseAcceptance = resolve;
      accepted();
    });
    try {
      await route.fulfill({ response });
    } catch (error) {
      deliveryError = error;
    } finally {
      completed();
    }
  });
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await incoming.waitFor();
  await incoming.getByRole("button", { name: "Accept", exact: true }).click();
  await committed;
  await incoming.waitFor({ state: "detached" });
  await b.getByRole("button", { name: "Sign out", exact: true }).click();
  await b.getByLabel("Username or email").waitFor();
  await b.getByLabel("Username or email").fill(aliceName);
  await b.getByLabel("Password", { exact: true }).fill(password);
  await b.getByRole("button", { name: "Sign in", exact: true }).click();
  await b.locator(".status-dot.online").waitFor();
  releaseAcceptance();
  await delivered;
  assert.equal(deliveryError, undefined);
  await b.unroute("**/api/v1/voice/rings/*/accept");
  await b.waitForTimeout(1200);
  assert.equal(await b.locator(".voice-bar").count(), 0);
  assert.equal(await b.locator(".voice-page").count(), 0);
  console.log(
    "PASS delayed acceptance cannot reopen media after logout and sign-in as another user",
  );
  if (await a.locator(".voice-bar").count())
    await a
      .locator(".voice-bar")
      .getByRole("button", { name: "Close", exact: true })
      .click();
} catch (error) {
  for (let i = 0; i < pages.length; i++) {
    console.log(
      "Voice UI:",
      await pages[i].locator(".toast").allTextContents(),
    );
    await pages[i].screenshot({
      path: "../../.cache/web-shots/voice-failure-" + i + ".png",
    });
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
