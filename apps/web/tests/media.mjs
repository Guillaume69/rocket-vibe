import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_MEDIA_USER || "webmedia",
  peername = process.env.RV_WEB_MEDIA_PEER || "webmediapeer",
  password = "web-client-disposable-password";
assert.ok(username.startsWith("webmedia") && peername.startsWith("webmedia"));
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
  const data = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, path + " " + response.status);
  return data;
}
const user = await api("/api/v1/auth/login", null, { username, password }),
  peer = await api("/api/v1/auth/login", null, {
    username: peername,
    password,
  });
const room = await api("/api/v1/rooms", peer.token, {
  name: "media-" + crypto.randomUUID().slice(0, 8),
  private: true,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + user.user.id,
  peer.token,
  null,
);
await writeFile(
  "../../.cache/media-room.json",
  JSON.stringify({
    id: room.id,
    name: room.name,
    owner: peername,
    member: username,
  }),
);
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const referrers = [];
await page.route(
  /https:\/\/(www\.youtube-nocookie\.com|www\.dailymotion\.com|player\.vimeo\.com)\/.*(?:embed|video).*/,
  async (route) => {
    referrers.push({
      url: route.request().url(),
      referer: route.request().headers().referer,
      authorization: route.request().headers().authorization,
    });
    await route.fulfill({
      contentType: "text/html",
      body:
        '<!doctype html><title>Isolated embed fixture</title><script>window.fixtureIdentity="' +
        crypto.randomUUID() +
        '";</script>',
    });
  },
);
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
  await page.locator(".room-content .rich-composer").waitFor();
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const draw = canvas.getContext("2d"),
      audio = new AudioContext(),
      tone = audio.createOscillator(),
      gain = audio.createGain(),
      output = audio.createMediaStreamDestination();
    gain.gain.value = 0.02;
    tone.connect(gain).connect(output);
    tone.start();
    const stream = canvas.captureStream(20);
    for (const track of output.stream.getAudioTracks()) stream.addTrack(track);
    let frame = 0;
    const tick = setInterval(() => {
      draw.fillStyle = frame % 2 ? "#ff5fa2" : "#32d6cf";
      draw.fillRect(0, 0, 320, 180);
      draw.fillStyle = "#171529";
      draw.font = "24px sans-serif";
      draw.fillText("RocketVibe " + frame++, 24, 90);
    }, 50);
    const parts = [],
      recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8,opus",
        videoBitsPerSecond: 160000,
      });
    return await new Promise((resolve) => {
      recorder.ondataavailable = (event) => parts.push(event.data);
      recorder.onstop = async () => {
        clearInterval(tick);
        tone.stop();
        for (const track of stream.getTracks()) track.stop();
        await audio.close();
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(new Blob(parts, { type: "video/webm" }));
      };
      recorder.start();
      setTimeout(() => recorder.stop(), 11000);
    });
  });
  const bytes = Buffer.from(encoded, "base64");
  await mkdir("../../.cache/web-shots", { recursive: true });
  await writeFile("../../.cache/media-fixture.webm", bytes);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Attach a file", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "gtk-reference.webm",
    mimeType: "video/webm",
    buffer: bytes,
  });
  await page.locator(".staged-chip").waitFor();
  await page.locator(".room-content .rich-composer").fill("Media caption");
  await page.locator(".room-content .rich-composer").press("Enter");
  const card = page.locator(".video-attachment").first();
  await card.waitFor();
  await card.locator("video").waitFor();
  await card
    .locator("video")
    .evaluate((video) =>
      video.readyState >= 2
        ? undefined
        : new Promise((resolve) =>
            video.addEventListener("loadeddata", resolve, { once: true }),
          ),
    );
  const evidence = await card.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    ratio:
      node.querySelector(".video-frame").getBoundingClientRect().width /
      node.querySelector(".video-frame").getBoundingClientRect().height,
    controls: node.querySelector("video").controls,
    paused: node.querySelector("video").paused,
    pixels: node.querySelector("video").videoWidth,
  }));
  assert.equal(evidence.width, 360);
  assert.ok(evidence.ratio > 1.77 && evidence.ratio < 1.79);
  assert.equal(evidence.controls, false);
  assert.equal(evidence.paused, true);
  assert.equal(evidence.pixels, 320);
  await page.screenshot({
    path: "../../.cache/web-shots/web-video-poster-reference.png",
  });
  console.log(
    "PASS a real protected video renders its first frame in the GTK 16:9 card without browser stock controls",
  );
  await card.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForFunction(
    () => document.querySelector(".video-attachment video").currentTime > 0.2,
  );
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await card.getByLabel("Playback position", { exact: true }).fill("1");
  await card
    .getByLabel("Playback position", { exact: true })
    .dispatchEvent("input");
  assert.ok(
    await card
      .locator("video")
      .evaluate((video) => Math.abs(video.currentTime - 1) < 0.1),
  );
  await card
    .locator(".audio-controls")
    .getByRole("button", { name: "Volume", exact: true })
    .click();
  await card.locator("input.audio-volume").fill("0.35");
  await card.locator("input.audio-volume").dispatchEvent("input");
  assert.ok(
    await card
      .locator("video")
      .evaluate((video) => Math.abs(video.volume - 0.35) < 0.01),
  );
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.waitForFunction(() =>
    document.fullscreenElement?.classList.contains("video-frame"),
  );
  await page
    .getByRole("button", { name: "Exit full screen", exact: true })
    .click();
  await page.waitForFunction(() => !document.fullscreenElement);
  const movie = await card.locator("video").elementHandle();
  const messageId = await card.evaluate(
    (node) => node.closest("[data-id]").dataset.id,
  );
  await movie.evaluate((video) => {
    video.dataset.retained = "same-player";
  });
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await api(
    "/api/v1/messages/" + messageId + "/reactions",
    peer.token,
    { emoji: "thumbsup", present: true, operation_id: crypto.randomUUID() },
    "PUT",
  );
  await page
    .locator('[data-id="' + messageId + '"] .reactions')
    .filter({ hasText: "1" })
    .waitFor();
  assert.equal(
    await card.locator("video").getAttribute("data-retained"),
    "same-player",
  );
  assert.equal(
    await card.evaluate(
      (node) =>
        document.fullscreenElement === node.querySelector(".video-frame"),
    ),
    true,
  );
  await card
    .getByRole("button", { name: "Exit full screen", exact: true })
    .click();
  await page.screenshot({
    path: "../../.cache/web-shots/web-video-controls-reference.png",
  });
  console.log(
    "PASS actual video playback, seeking, volume and fullscreen retain the same player during a live reaction",
  );
  const links =
    "https://youtu.be/M7lc1UVf-VE https://youtube.com/shorts/M7lc1UVf-VE https://vimeo.com/12345678 https://dai.ly/x9abcde https://vimeo.com/87654321";
  const linked = await api(
    "/api/v1/rooms/" + room.id + "/messages",
    peer.token,
    { text: links, operation_id: crypto.randomUUID() },
  );
  const row = page.locator('[data-id="' + linked.id + '"]');
  await row.locator(".embedded-video").first().waitFor();
  assert.equal(await row.locator(".embedded-video").count(), 3);
  const youtube = row.locator('[data-video-key="YouTube:M7lc1UVf-VE"]');
  await youtube
    .getByRole("button", { name: "Play YouTube", exact: true })
    .click();
  const iframe = await youtube.locator("iframe").elementHandle();
  await page.waitForFunction(
    () => document.querySelector(".embedded-video iframe")?.contentWindow,
  );
  const frame = await iframe.contentFrame();
  await frame.waitForFunction(() => window.fixtureIdentity);
  const identity = await frame.evaluate(() => window.fixtureIdentity);
  assert.equal(referrers[0].referer, new URL(base).origin + "/");
  assert.equal(referrers[0].authorization, undefined);
  assert.ok(referrers[0].url.includes("autoplay=1"));
  await api(
    "/api/v1/messages/" + linked.id + "/reactions",
    user.token,
    { emoji: "thumbsup", present: true, operation_id: crypto.randomUUID() },
    "PUT",
  );
  await row.locator(".reactions").filter({ hasText: "1" }).waitFor();
  assert.equal(await frame.evaluate(() => window.fixtureIdentity), identity);
  await youtube
    .getByRole("button", { name: "Stop the video", exact: true })
    .click();
  await youtube.locator("iframe").waitFor({ state: "detached" });
  assert.equal(await youtube.locator(".video-thumb").isVisible(), true);
  console.log(
    "PASS canonical video-site cards are deduplicated, keep the embed on live updates and identify only the origin without a bearer",
  );
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await api(
    "/api/v1/rooms/" + room.id + "/members/" + user.user.id,
    peer.token,
    undefined,
    "DELETE",
  );
  await page
    .locator('[data-room="' + room.id + '"]')
    .waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(
    await movie.evaluate((video) => video.hasAttribute("src")),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS membership withdrawal stops the private video and closes its fullscreen surface",
  );
} catch (error) {
  await page.screenshot({ path: "../../.cache/web-shots/media-failure.png" });
  console.log("Media UI:", await page.locator(".toast").allTextContents());
  throw error;
} finally {
  await browser.close();
}
