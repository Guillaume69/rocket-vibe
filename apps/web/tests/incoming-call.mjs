// Native incoming-call prompts remain until an explicit choice or real teardown.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const names = [
    process.env.RV_WEB_INCOMING_USER || "webincoming",
    process.env.RV_WEB_INCOMING_PEER || "webincomingpeer",
  ],
  password = "web-client-disposable-password";
assert.ok(names.every((name) => name.startsWith("webincoming")));
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
const accounts = await Promise.all(
    names.map((username) =>
      api("/api/v1/auth/login", undefined, { username, password }),
    ),
  ),
  direct = await api("/api/v1/direct-messages", accounts[0].token, {
    user_id: accounts[1].user.id,
  });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const pages = [],
  sessions = [],
  errors = [],
  answers = [];
async function login(index) {
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone", "camera"],
  });
  await context.addInitScript(() => {
    window.__incomingPeers = [];
    window.__incomingCaptures = [];
    window.__incomingContexts = [];
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(Target, args) {
        const peer = new Target(...args);
        window.__incomingPeers.push(peer);
        return peer;
      },
    });
    const NativeAudio = AudioContext;
    window.AudioContext = new Proxy(NativeAudio, {
      construct(Target, args) {
        const context = new Target(...args);
        window.__incomingContexts.push(context);
        return context;
      },
    });
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await capture(options);
      window.__incomingCaptures.push(...stream.getTracks());
      return stream;
    };
  });
  const page = await context.newPage();
  pages.push(page);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/voice\/rings\/[^/]+\/(accept|decline)$/.test(
        new URL(request.url()).pathname,
      )
    )
      answers.push({ index, path: new URL(request.url()).pathname });
  });
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
  await page.getByLabel("Username or email").fill(names[index]);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const authenticated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/auth/start" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const step = await (await authenticated).json();
  assert.equal(step.kind, "session");
  sessions[index] = step.session;
  await page.locator(".status-dot.online").waitFor({ timeout: 45000 });
  await page.locator('.room-row[data-room="' + direct.id + '"]').click();
  await page.locator(".room-content .rich-composer").waitFor();
  return page;
}
const prompt = (page) => page.locator("dialog.voice-ring-dialog");
async function start(caller, callee) {
  if (await caller.locator(".voice-page").isVisible())
    await caller
      .getByRole("button", { name: "Open the chat", exact: true })
      .click();
  const [accepted] = await Promise.all([
    caller.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          "/api/v1/rooms/" + direct.id + "/voice/join",
    ),
    caller.getByRole("button", { name: "Start a call", exact: true }).click(),
  ]);
  assert.ok(accepted.ok());
  const grant = await accepted.json();
  assert.equal(grant.ring.state, "ringing");
  await prompt(callee).waitFor();
  assert.equal(
    await prompt(callee).getAttribute("aria-labelledby"),
    "voice-ring-" + grant.ring.id,
    "the displayed prompt belongs to this exact server ring",
  );
  assert.equal(
    await prompt(callee).getByRole("heading").textContent(),
    "Incoming call",
  );
  return grant.ring.id;
}
const ring = (id) => api("/api/v1/voice/rings/" + id, accounts[0].token);
async function idle(page) {
  await page
    .locator(".voice-bar")
    .waitFor({ state: "detached", timeout: 30000 });
  await page.waitForFunction(
    () =>
      window.__incomingPeers.every(
        (peer) => peer.connectionState === "closed",
      ) &&
      window.__incomingCaptures.every(
        (track) => track.readyState === "ended",
      ) &&
      window.__incomingContexts.every((audio) => audio.state === "closed"),
  );
}
async function rtp(page) {
  await page.waitForFunction(
    async () => {
      const stats = (
        await Promise.all(
          window.__incomingPeers
            .filter((peer) => peer.connectionState !== "closed")
            .map((peer) => peer.getStats()),
        )
      ).flatMap((report) => [...report.values()]);
      return (
        stats.some(
          (item) =>
            item.type === "outbound-rtp" &&
            item.kind === "audio" &&
            item.bytesSent > 1000,
        ) &&
        stats.some(
          (item) =>
            item.type === "inbound-rtp" &&
            item.kind === "audio" &&
            item.bytesReceived > 1000,
        )
      );
    },
    undefined,
    { timeout: 30000 },
  );
}
await mkdir("../../.cache/web-shots", { recursive: true });
try {
  const a = await login(0),
    b = await login(1);
  let id = await start(a, b);
  const before = answers.length;
  for (const action of [
    () => b.mouse.click(1, 1),
    () => b.keyboard.press("Escape"),
  ]) {
    await action();
    await b.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(
      await prompt(b).isVisible(),
      true,
      "outside/Escape preserve the incoming prompt",
    );
    assert.equal((await ring(id)).state, "ringing");
    assert.equal(
      answers.length,
      before,
      "dismissal attempts send neither Accept nor Decline",
    );
  }
  assert.equal(await b.locator(".voice-bar").count(), 0);
  assert.deepEqual(
    await b.evaluate(() => ({
      peers: window.__incomingPeers.length,
      captures: window.__incomingCaptures.length,
    })),
    { peers: 0, captures: 0 },
  );
  await b.screenshot({
    path: "../../.cache/web-shots/web-incoming-call-explicit-actions.png",
  });
  console.log(
    "PASS outside click and Escape keep the real ring pending without an answer or media allocation",
  );

  const declined = b.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/voice/rings/" + id + "/decline" &&
      response.request().method() === "POST",
  );
  await prompt(b).getByRole("button", { name: "Decline", exact: true }).click();
  assert.ok((await declined).ok());
  await prompt(b).waitFor({ state: "detached" });
  assert.equal((await ring(id)).state, "declined");
  await idle(a);
  assert.equal(answers.length, before + 1);
  console.log(
    "PASS explicit Decline resolves the server ring and stops the caller without joining the callee",
  );

  id = await start(a, b);
  const beforeCancel = answers.length;
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await idle(a);
  await prompt(b).waitFor({ state: "detached", timeout: 30000 });
  assert.equal((await ring(id)).state, "cancelled");
  assert.equal(answers.length, beforeCancel);
  console.log(
    "PASS caller cancellation removes the incoming prompt through real live state without fabricating a decline",
  );

  id = await start(a, b);
  const accepted = b.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/voice/rings/" + id + "/accept" &&
      response.request().method() === "POST",
  );
  await prompt(b).getByRole("button", { name: "Accept", exact: true }).click();
  assert.ok((await accepted).ok());
  await prompt(b).waitFor({ state: "detached" });
  for (const page of [a, b]) {
    await page.locator(".voice-status.connected").waitFor({ timeout: 30000 });
    const microphone = page
      .locator(".voice-controls")
      .getByRole("button", { name: "Microphone", exact: true });
    if ((await microphone.getAttribute("aria-pressed")) === "true")
      await microphone.click();
  }
  assert.equal((await ring(id)).state, "answered");
  await Promise.all([rtp(a), rtp(b)]);
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await Promise.all([idle(a), idle(b)]);
  console.log(
    "PASS explicit Accept joins the real SFU with bidirectional audio RTP; remote leave closes both owned media lifetimes",
  );

  id = await start(a, b);
  const beforeLogout = answers.length;
  // Revoke this exact browser session through the actual authenticated server.
  // Its reconnect receives 401 and purges the prompt with the account lifetime.
  await api("/api/v1/auth/logout", sessions[1].token, undefined, "POST");
  await b.getByLabel("Username or email").waitFor({ timeout: 45000 });
  assert.equal(await prompt(b).count(), 0);
  assert.equal(answers.length, beforeLogout);
  await idle(b);
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await idle(a);
  console.log(
    "PASS actual browser-session revocation closes the account's incoming prompt without implicitly answering it",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  for (let index = 0; index < pages.length; index++)
    if (!pages[index].isClosed())
      await pages[index].screenshot({
        path: "../../.cache/web-shots/incoming-call-failure-" + index + ".png",
        mask: [
          pages[index].locator(
            'input[type="password"],input[autocomplete="one-time-code"]',
          ),
        ],
      });
  throw error;
} finally {
  await browser.close();
  for (const account of [...accounts, ...sessions])
    if (account)
      await api("/api/v1/auth/logout", account.token, undefined, "POST").catch(
        () => {},
      );
}
