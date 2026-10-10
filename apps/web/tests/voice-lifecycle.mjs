import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const names = [
  process.env.RV_WEB_LIFECYCLE_USER || "webvoicelifecycle",
  process.env.RV_WEB_LIFECYCLE_PEER || "webvoicelifecyclepeer",
];
assert.ok(names.every((name) => name.startsWith("webvoice")));
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
);
const fixtureTokens = accounts.map((account) => account.token);
const room = await api("/api/v1/rooms", accounts[0].token, {
  name: "voice-lifetime-" + crypto.randomUUID().slice(0, 8),
  private: true,
  voice: true,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + accounts[1].user.id,
  accounts[0].token,
  null,
);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const contexts = [],
  pages = [],
  errors = [];
async function login(index) {
  const context = await browser.newContext({
    locale: "en-US",
    permissions: ["microphone", "camera"],
  });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__voiceConnections = [];
    window.__voiceContexts = [];
    window.__voiceCaptures = [];
    window.__syncSockets = [];
    window.__voiceNotices = [];
    window.__screenCaptures = [];
    addEventListener("DOMContentLoaded", () => {
      new MutationObserver((changes) => {
        for (const change of changes)
          for (const node of change.addedNodes)
            if (node instanceof HTMLElement && node.classList.contains("toast"))
              window.__voiceNotices.push(node.textContent);
      }).observe(document.querySelector("#toasts"), { childList: true });
    });
    // A controlled screen source isolates call lifetime and avatar geometry.
    // OS consent/capture remains covered by the separate voice/platform suite.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      let frame = 0;
      const clock = setInterval(() => {
        context.fillStyle = frame++ % 2 ? "#35d5ce" : "#ff5fa2";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      const stream = canvas.captureStream(20);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(clock);
          stop();
        };
      }
      window.__screenCaptures.push(...stream.getTracks());
      return stream;
    };
    const NativePeer = RTCPeerConnection;
    const configure = NativePeer.prototype.setConfiguration;
    NativePeer.prototype.setConfiguration = function (options) {
      return configure.call(
        this,
        window.__forceVoiceRelay
          ? { ...options, iceTransportPolicy: "relay" }
          : options,
      );
    };
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(Target, args) {
        const peer = new Target(
          window.__forceVoiceRelay
            ? { ...args[0], iceTransportPolicy: "relay" }
            : args[0],
        );
        peer.fixtureRelay = window.__forceVoiceRelay === true;
        window.__voiceConnections.push(peer);
        return peer;
      },
    });
    const NativeAudio = AudioContext;
    window.AudioContext = new Proxy(NativeAudio, {
      construct(Target, args) {
        const audio = new Target(...args);
        const sink = audio.setSinkId?.bind(audio);
        if (sink)
          audio.setSinkId = async (id) => {
            if (window.__holdVoiceSink) {
              window.__holdVoiceSink = false;
              await new Promise(
                (resolve) => (window.__releaseVoiceSink = resolve),
              );
            }
            try {
              return await sink(id);
            } catch (error) {
              if (audio.state === "closed")
                window.__retiredSinkFailure = error.name;
              throw error;
            }
          };
        window.__voiceContexts.push(audio);
        return audio;
      },
    });
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await capture(options);
      window.__voiceCaptures.push(...stream.getTracks());
      if (options.video && window.__holdVoiceCamera)
        await new Promise((resolve) => (window.__releaseVoiceCamera = resolve));
      return stream;
    };
    const NativeSocket = WebSocket;
    window.WebSocket = new Proxy(NativeSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        if (String(args[0]).includes("/api/v1/sync/socket")) {
          window.__syncSockets.push(socket);
          socket.addEventListener("message", (event) => {
            const frame = JSON.parse(event.data);
            if (frame.changes) socket.fixtureBatch = frame;
          });
        }
        return socket;
      },
    });
  });
  const page = await context.newPage();
  pages.push(page);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("Username or email").fill(names[index]);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const authenticated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/start") &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const step = await (await authenticated).json();
  assert.equal(step.kind, "session");
  fixtureTokens.push(step.session.token);
  await page.locator(".status-dot.online").waitFor();
  return page;
}
async function select(page, id, voice = true) {
  await page
    .locator('[data-room="' + id + '"]')
    .first()
    .click();
  if (voice)
    await page.locator(".voice-status.connected").waitFor({ timeout: 30000 });
}
async function leave(page) {
  if (await page.locator(".voice-bar").count())
    await page
      .locator(".voice-bar")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  await page.locator(".voice-bar").waitFor({ state: "detached" });
}
async function rtp(page, inbound = true) {
  await page.waitForFunction(
    async (inbound) => {
      const stats = (
        await Promise.all(
          window.__voiceConnections
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
        (!inbound ||
          stats.some(
            (item) =>
              item.type === "inbound-rtp" &&
              item.kind === "audio" &&
              item.bytesReceived > 1000,
          ))
      );
    },
    inbound,
    { timeout: 30000 },
  );
}
async function serverConnected(id, user) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const live = await api("/api/v1/live", accounts[1].token);
    if (
      live.data.rooms
        .find((item) => item.room_id === id)
        ?.voice?.some((person) => person.user.id === user)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(
    "The SFU participant must reach the native connected roster before claiming a screen",
  );
}
try {
  const a = await login(0),
    b = await login(1);
  await a.evaluate(() => (window.__holdVoiceSink = true));
  await select(a, room.id);
  await a.waitForFunction(
    () => typeof window.__releaseVoiceSink === "function",
  );
  await select(b, room.id);
  await rtp(a);
  await rtp(b);
  let aLeaves = 0;
  a.on("request", (request) => {
    if (
      request.url().endsWith("/api/v1/voice/leave") &&
      request.method() === "POST"
    )
      aLeaves++;
  });
  const c = await login(0);
  await select(c, room.id);
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await a.waitForFunction(() =>
    window.__voiceContexts.every((audio) => audio.state === "closed"),
  );
  await a.evaluate(() => window.__releaseVoiceSink());
  await a.waitForFunction(
    () => window.__retiredSinkFailure === "InvalidStateError",
  );
  assert.ok(
    !(await a.evaluate(() => window.__voiceNotices)).some((notice) =>
      notice.includes("setSinkId"),
    ),
  );
  await a
    .locator(".toast")
    .filter({ hasText: "Voice continues on another device." })
    .waitFor();
  await rtp(c);
  await c.waitForTimeout(2300);
  assert.equal(
    aLeaves,
    0,
    "the replaced browser must not leave the replacement's user-wide session",
  );
  assert.equal(await c.locator(".voice-status.connected").count(), 1);
  console.log(
    "PASS duplicate-identity takeover stops the old browser without evicting the replacement's real audio",
  );

  let cLeaves = 0;
  c.on("request", (request) => {
    if (
      request.url().endsWith("/api/v1/voice/leave") &&
      request.method() === "POST"
    )
      cLeaves++;
  });
  const elsewhere = await api("/api/v1/rooms", accounts[0].token, {
    name: "voice-elsewhere-" + crypto.randomUUID().slice(0, 8),
    private: true,
    voice: true,
    operation_id: crypto.randomUUID(),
  });
  await select(a, elsewhere.id);
  await c.locator(".voice-bar").waitFor({ state: "detached" });
  await rtp(a, false);
  await a.waitForTimeout(2300);
  assert.equal(
    cLeaves,
    0,
    "server participant removal must not leave the account's new room",
  );
  assert.equal(await a.locator(".voice-status.connected").count(), 1);
  console.log(
    "PASS moving the account to another room cleans up the removed browser without posting a stale leave",
  );
  await leave(a);
  await contexts[2].close();
  await select(a, room.id);
  await serverConnected(room.id, accounts[0].user.id);

  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  await a
    .getByRole("dialog", { name: "Share your screen", exact: true })
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await b.locator(".voice-screen-stage:not([hidden]) video").waitFor();
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Camera", exact: true })
    .click();
  const camera = b.locator('[data-participant="' + accounts[0].user.id + '"]');
  await camera.locator("video:not([hidden])").waitFor();
  await b.waitForFunction((id) => {
    const video = document.querySelector(
      '[data-participant="' + id + '"] video',
    );
    return video?.videoWidth > 0;
  }, accounts[0].user.id);
  assert.equal(await camera.locator(".voice-avatar").isVisible(), false);
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Camera", exact: true })
    .click();
  await camera.locator(".voice-avatar").waitFor({ state: "visible" });
  assert.equal(await camera.locator("video:not([hidden])").count(), 0);
  assert.equal(
    await camera
      .getAttribute("class")
      .then((value) => value.includes("has-camera")),
    false,
  );
  console.log(
    "PASS disabling a real camera publication restores the GTK avatar and participant-strip geometry",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();

  await a.evaluate(() => (window.__holdVoiceCamera = true));
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Camera", exact: true })
    .click();
  await a.waitForFunction(() => window.__releaseVoiceCamera);
  await leave(a);
  const releasedAt = Date.now();
  await a.evaluate(() => window.__releaseVoiceCamera());
  await a.waitForFunction(
    () =>
      window.__voiceCaptures
        .filter((track) => track.kind === "video")
        .every((track) => track.readyState === "ended"),
    {},
    { timeout: 2000 },
  );
  assert.ok(
    Date.now() - releasedAt < 2000,
    "late camera capture must stop before the SDK's 15-second publication timeout",
  );
  assert.equal(await a.locator(".voice-bar").count(), 0);
  console.log(
    "PASS camera capture released after leaving stops immediately and cannot publish into the retired call",
  );
  await leave(b);

  const direct = await api("/api/v1/direct-messages", accounts[0].token, {
    user_id: accounts[1].user.id,
  });
  await select(a, direct.id, false);
  await select(b, direct.id, false);
  await b.evaluate(() => (window.__forceVoiceRelay = true));
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  const incoming = b.locator("dialog").filter({
    has: b.getByRole("heading", { name: "Incoming call", exact: true }),
  });
  await incoming.waitFor();
  await incoming.getByRole("button", { name: "Accept", exact: true }).click();
  await b.waitForFunction(
    () =>
      window.__voiceConnections.some((peer) => peer.fixtureRelay) &&
      window.__voiceConnections
        .filter((peer) => peer.fixtureRelay)
        .every(
          (peer) => peer.getConfiguration().iceTransportPolicy === "relay",
        ),
  );
  await b
    .locator(".toast")
    .filter({ hasText: "Couldn't join voice." })
    .waitFor({ timeout: 30000 });
  await b.waitForFunction(
    () =>
      window.__voiceContexts.length > 0 &&
      window.__voiceContexts.every((audio) => audio.state === "closed"),
  );
  assert.equal(await b.locator(".voice-page").count(), 0);
  assert.equal(await b.locator(".voice-bar").count(), 0);
  await b.evaluate(() => (window.__forceVoiceRelay = false));
  await b.getByRole("button", { name: "Join call", exact: true }).click();
  await b.locator(".voice-status.connected").waitFor();
  await rtp(b);
  await leave(a);
  await b.locator(".voice-bar").waitFor({ state: "detached" });
  console.log(
    "PASS an actual accepted-call ICE failure closes the context and permits a fresh audio retry",
  );

  for (const change of ["removed", "replaced"]) {
    const callee = await login(1);
    await select(callee, direct.id, false);
    let releaseAcceptance, ready;
    const committed = new Promise((resolve) => (ready = resolve));
    const delivery = new Promise((resolve) => {
      callee.route("**/api/v1/voice/rings/*/accept", async (route) => {
        const response = await route.fetch();
        assert.ok(response.ok());
        await new Promise((resume) => {
          releaseAcceptance = resume;
          ready();
        });
        await route.fulfill({ response });
        resolve();
      });
    });
    await a.getByRole("button", { name: "Join call", exact: true }).click();
    const prompt = callee.locator("dialog").filter({
      has: callee.getByRole("heading", {
        name: "Incoming call",
        exact: true,
      }),
    });
    await prompt.waitFor();
    const before = await callee.evaluate(() => ({
      captures: window.__voiceCaptures.length,
      contexts: window.__voiceContexts.length,
      peers: window.__voiceConnections.length,
    }));
    await prompt.getByRole("button", { name: "Accept", exact: true }).click();
    await committed;
    const details = await api("/api/v1/rooms/" + direct.id, accounts[1].token);
    // Direct-room membership cannot be removed through ordinary member APIs.
    // Feed the browser a supported sync frame to qualify the lifetime fence;
    // this fixture does not claim a server-side direct-room revocation test.
    await callee.evaluate(
      ({ change, room }) => {
        const socket = window.__syncSockets.at(-1);
        assertFixture(socket.fixtureBatch);
        const data =
          change === "removed"
            ? { type: "room_removed", data: { room_id: room.id } }
            : {
                type: "room_upsert",
                data: {
                  ...room,
                  revision: String(BigInt(room.revision) + 1n),
                  read_state: {
                    ...room.read_state,
                    membership_version: "fixture-replaced-membership",
                  },
                },
              };
        socket.onmessage(
          new MessageEvent("message", {
            data: JSON.stringify({ ...socket.fixtureBatch, changes: [data] }),
          }),
        );
        function assertFixture(batch) {
          if (!batch) throw new Error("No actual sync frame observed");
        }
      },
      { change, room: details.room },
    );
    if (change === "removed")
      await callee
        .locator('[data-room="' + direct.id + '"]')
        .waitFor({ state: "detached" });
    else await callee.waitForTimeout(300);
    releaseAcceptance();
    await delivery;
    await callee.waitForTimeout(500);
    assert.deepEqual(
      await callee.evaluate(() => ({
        captures: window.__voiceCaptures.length,
        contexts: window.__voiceContexts.length,
        peers: window.__voiceConnections.length,
      })),
      before,
    );
    assert.equal(await callee.locator(".voice-bar").count(), 0);
    assert.equal(await callee.locator(".voice-page").count(), 0);
    await leave(a);
    await callee.context().close();
    console.log(
      "PASS delayed acceptance cannot start RTC or capture after a membership-" +
        change +
        " sync frame",
    );
  }
  for (const page of pages)
    if (!page.isClosed())
      await page.waitForFunction(
        () =>
          window.__voiceContexts.every((audio) => audio.state === "closed") &&
          window.__voiceConnections.every(
            (peer) => peer.connectionState === "closed",
          ) &&
          window.__voiceCaptures.every(
            (track) => track.readyState === "ended",
          ) &&
          window.__screenCaptures.every(
            (track) => track.readyState === "ended",
          ),
      );
  console.log(
    "PASS all owned audio contexts, peer connections and microphone/camera captures are closed after teardown",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  await mkdir("../../.cache/web-shots", { recursive: true });
  for (let index = 0; index < pages.length; index++)
    if (!pages[index].isClosed()) {
      await pages[index]
        .screenshot({
          path:
            "../../.cache/web-shots/voice-lifecycle-failed-" + index + ".png",
        })
        .catch(() => {});
      console.log(
        "Lifecycle UI:",
        await pages[index].evaluate(() => window.__voiceNotices),
      );
    }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  for (const token of fixtureTokens)
    await api("/api/v1/auth/logout", token, undefined, "POST").catch(() => {});
}
