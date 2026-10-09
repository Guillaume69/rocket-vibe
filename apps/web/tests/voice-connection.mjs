import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox } from "playwright";

const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const names = [
  process.env.RV_WEB_CONNECTION_USER || "webconnection",
  process.env.RV_WEB_CONNECTION_PEER || "webconnectionpeer",
];
const password = "web-client-disposable-password";
async function request(path, token, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, response.status + " " + JSON.stringify(data));
  return data;
}
const accounts = [];
for (const username of names)
  accounts.push(
    await request("/api/v1/auth/login", undefined, { username, password }),
  );
const room = await request("/api/v1/rooms", accounts[0].token, {
  name: "voice-connection-" + crypto.randomUUID().slice(0, 8),
  private: false,
  voice: true,
  operation_id: crypto.randomUUID(),
});
await request(
  "/api/v1/rooms/" + room.id + "/members/" + accounts[1].user.id,
  accounts[0].token,
  null,
);
const browsers = [],
  contexts = [],
  pages = [];
try {
  browsers.push(
    await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "media.navigator.streams.fake": true,
        "media.navigator.permission.disabled": true,
        // Keep Firefox's normal loopback policy. A test override would hide the
        // local SFU configuration failure that prompted this regression suite.
        "media.peerconnection.ice.loopback": false,
      },
    }),
  );
  browsers.push(
    await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    }),
  );
  for (let index = 0; index < browsers.length; index++) {
    const context = await browsers[index].newContext({ locale: "en-US" });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__voiceConnections = [];
      window.__voiceContexts = [];
      const NativePeer = RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(NativePeer, {
        construct(Target, args) {
          const options = window.__forceVoiceRelay
            ? { ...args[0], iceTransportPolicy: "relay" }
            : args[0];
          const connection = new Target(options);
          window.__voiceConnections.push(connection);
          return connection;
        },
      });
      const NativeAudio = AudioContext;
      window.AudioContext = new Proxy(NativeAudio, {
        construct(Target, args) {
          const context = new Target(...args);
          window.__voiceContexts.push(context);
          return context;
        },
      });
    });
    const page = await context.newPage();
    pages.push(page);
    await page.goto(base);
    await page.getByLabel("Username or email").fill(names[index]);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".status-dot.online").waitFor();
    await page
      .locator('[data-room="' + room.id + '"]')
      .first()
      .click();
    await page.locator(".voice-status.connected").waitFor({ timeout: 30000 });
  }
  const [a, b] = pages;
  for (const page of pages) {
    await page.waitForFunction(
      async () => {
        const stats = (
          await Promise.all(
            window.__voiceConnections.map((pc) => pc.getStats()),
          )
        ).flatMap((report) => [...report.values()]);
        return (
          stats.some(
            (item) =>
              item.type === "inbound-rtp" &&
              (item.kind || item.mediaType) === "audio" &&
              item.bytesReceived > 1000,
          ) &&
          stats.some(
            (item) =>
              item.type === "outbound-rtp" &&
              (item.kind || item.mediaType) === "audio" &&
              item.bytesSent > 1000,
          )
        );
      },
      {},
      { timeout: 30000 },
    );
    await page
      .locator(
        '.room-voice-roster[data-voice-room="' +
          room.id +
          '"] .room-voice-person',
      )
      .nth(1)
      .waitFor();
  }
  console.log(
    "PASS Firefox and Chromium autojoin voice channels, exchange real audio RTP and show both live occupants",
  );
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await a.evaluate(() => {
    window.__forceVoiceRelay = true;
  });
  await a
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await a.locator(".voice-page").waitFor();
  await a
    .locator(".toast")
    .filter({ hasText: "Couldn't join voice." })
    .waitFor({ timeout: 30000 });
  await a.locator(".voice-page").waitFor({ state: "detached" });
  await a.waitForFunction(() =>
    window.__voiceContexts.every((context) => context.state === "closed"),
  );
  assert.equal(await a.locator(".voice-bar").count(), 0);
  console.log(
    "PASS an actual ICE timeout reports the native failure and releases the pending call and audio context",
  );
  await a.evaluate(() => {
    window.__forceVoiceRelay = false;
  });
  await a
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await a.locator(".voice-status.connected").waitFor();
  await a.waitForFunction(async () =>
    [...(await window.__voiceConnections.at(-1).getStats()).values()].some(
      (item) => item.type === "inbound-rtp" && item.bytesReceived > 1000,
    ),
  );
  console.log(
    "PASS retry after the failed ICE attempt reconnects and receives the other participant's audio",
  );
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await b
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  for (const page of pages)
    await page.waitForFunction(
      () =>
        window.__voiceContexts.every((context) => context.state === "closed") &&
        window.__voiceConnections.every(
          (pc) => pc.connectionState === "closed",
        ),
    );
} catch (error) {
  await mkdir("../../.cache/web-shots", { recursive: true });
  for (let index = 0; index < pages.length; index++) {
    console.log(
      "Connection UI:",
      await pages[index].locator(".toast").allTextContents(),
    );
    await pages[index].screenshot({
      path: "../../.cache/web-shots/voice-connection-failed-" + index + ".png",
    });
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  for (const browser of browsers) await browser.close();
}
