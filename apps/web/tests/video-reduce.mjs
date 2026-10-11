// Video reduction before sending: a generated 1600x900 WebM (VP8 and Opus,
// MediaRecorder) is staged, the reduction is cancelled from the strip, then
// sent reduced (H.264 MP4, short side 720, read back from the stored file),
// in original quality, and through a browser without an H.264 encoder.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const username = process.env.RV_WEB_VIDEO_USER || "webvideo",
  peername = process.env.RV_WEB_VIDEO_PEER || "webvideopeer";
assert.ok(username.startsWith("webvideo") && peername.startsWith("webvideo"));
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
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.ok(response.ok, path + " " + response.status);
  return data;
}
async function download(id, token) {
  const response = await fetch(base + "/api/v1/files/" + id, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.ok(response.ok, "file " + response.status);
  return Buffer.from(await response.arrayBuffer());
}
// The H.264 sample entry inside the MP4's stsd box: its coded size.
function mp4Video(bytes) {
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp");
  const stsd = bytes.indexOf("stsd", 0, "latin1");
  assert.ok(stsd > 0, "an stsd box");
  const avc1 = bytes.indexOf("avc1", stsd, "latin1");
  assert.ok(avc1 > stsd, "an avc1 sample entry");
  assert.ok(bytes.indexOf("avcC", avc1, "latin1") > avc1, "an avcC record");
  return {
    width: bytes.readUInt16BE(avc1 + 28),
    height: bytes.readUInt16BE(avc1 + 30),
  };
}
const user = await api("/api/v1/auth/login", null, { username, password });
const peer = await api("/api/v1/auth/login", null, {
  username: peername,
  password,
});
const room = await api("/api/v1/rooms", peer.token, {
  name: "video-" + crypto.randomUUID().slice(0, 8),
  private: true,
  operation_id: crypto.randomUUID(),
});
await api(
  "/api/v1/rooms/" + room.id + "/members/" + user.user.id,
  peer.token,
  null,
);
async function sent() {
  return (
    await api("/api/v1/rooms/" + room.id + "/messages", user.token)
  ).messages
    .filter((message) => message.files?.length)
    .sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1));
}
async function waitForFiles(count) {
  for (let i = 0; i < 120; i++) {
    const messages = await sent();
    if (messages.length >= count) return messages;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no message with " + count + " files");
}
await mkdir("../../.cache/web-shots", { recursive: true });
const browser = await chromium.launch({ headless: true });
// No service worker: its cache would hide the worker script from page.route.
async function open(init) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    serviceWorkers: "block",
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().startsWith("Video sent in original quality"))
      console.log("page:", message.text());
  });
  await page.goto(base);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".status-dot.online").waitFor();
  await page
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  return { context, page, errors };
}
let { context, page, errors } = await open();
try {
  // 2.5 s of 1600x900 at 30 fps with a tone: VP8 and Opus in WebM.
  const clip = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      // Opaque, like a camera: an alpha plane would need Mediabunny's blob:
      // merge workers, which the CSP (worker-src 'self') refuses.
      const draw = canvas.getContext("2d", { alpha: false });
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const sink = audio.createMediaStreamDestination();
      tone.connect(sink);
      tone.start();
      const stream = canvas.captureStream(30);
      stream.addTrack(sink.stream.getAudioTracks()[0]);
      const recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8,opus",
        videoBitsPerSecond: 8_000_000,
      });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      let frame = 0;
      const paint = () => {
        for (let y = 0; y < 900; y += 30)
          for (let x = 0; x < 1600; x += 40) {
            draw.fillStyle =
              "hsl(" +
              ((x + y + frame * 13) % 360) +
              ",80%," +
              (30 + ((x * y + frame) % 40)) +
              "%)";
            draw.fillRect(x, y, 40, 30);
          }
        draw.fillStyle = "#fff";
        draw.font = "120px sans-serif";
        draw.fillText("frame " + frame, 100 + frame * 9, 450);
        frame++;
      };
      paint();
      const timer = setInterval(paint, 33);
      recorder.start(250);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      tone.stop();
      await audio.close();
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }),
    "base64",
  );
  assert.equal(clip.readUInt32BE(0), 0x1a45dfa3, "a WebM source");
  const encodes = await page.evaluate(
    async () =>
      (
        await VideoEncoder.isConfigSupported({
          codec: "avc1.64001f",
          width: 1280,
          height: 720,
          bitrate: 2_000_000,
          framerate: 30,
        })
      ).supported === true,
  );
  async function stage(target = page) {
    const chosen = target.waitForEvent("filechooser");
    await target
      .getByRole("button", { name: "Attach a file", exact: true })
      .click();
    await (
      await chosen
    ).setFiles({ name: "clip.webm", mimeType: "video/webm", buffer: clip });
    await target.locator(".staged-chip").waitFor();
  }
  const composer = (target = page) =>
    target.locator(".room-content .rich-composer");
  await stage();
  const original = page.getByLabel("Videos in original quality", {
    exact: true,
  });
  assert.equal(await original.isChecked(), false);
  let checked = 0;
  if (encodes) {
    // Cancel: the worker script is held until Cancel has been pressed.
    let held = 0,
      release;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route(/video-reduce\.worker-[^/]*\.js$/, async (route) => {
      held++;
      await gate;
      await route.continue().catch(() => {});
    });
    await composer().fill("Reduced clip");
    await composer().press("Enter");
    const row = page.locator(".video-reduce");
    await row.waitFor();
    assert.match(await row.textContent(), /Reducing clip\.webm/);
    assert.equal(await row.locator("progress").count(), 1);
    assert.equal(await original.isDisabled(), true);
    await page.screenshot({
      path: "../../.cache/web-shots/web-video-reducing.png",
    });
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.waitFor({ state: "detached" });
    for (let i = 0; i < 40 && !held; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(held, 1, "the reduction had asked for its worker");
    release();
    await page.unroute(/video-reduce\.worker-[^/]*\.js$/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await page.locator(".staged-chip").count(), 1);
    assert.equal(await original.isDisabled(), false);
    assert.equal((await sent()).length, 0);
    assert.equal(await composer().textContent(), "Reduced clip");
    console.log(
      "PASS cancelling a video reduction stops it and keeps the file staged, nothing sent",
    );
    // Reduced: H.264 MP4 at 1280x720, the sound kept, lighter.
    await composer().press("Enter");
    const [reduced] = await waitForFiles(1);
    const file = reduced.files[0];
    assert.equal(file.filename, "clip.mp4");
    assert.equal(file.media_type, "video/mp4");
    assert.equal(reduced.text, "Reduced clip");
    assert.ok(Number(file.bytes) < clip.length, "lighter than the source");
    const bytes = await download(file.id, user.token);
    assert.equal(bytes.length, Number(file.bytes));
    assert.deepEqual(mp4Video(bytes), { width: 1280, height: 720 });
    assert.ok(
      bytes.indexOf("Opus", 0, "latin1") > 0 ||
        bytes.indexOf("mp4a", 0, "latin1") > 0,
      "an audio track",
    );
    await page.locator(".video-card").first().waitFor();
    assert.equal(await page.locator(".staged-chip").count(), 0);
    // The stored MP4 plays: a decoded 1280x720 frame with the clip's colours.
    const playable = await page.evaluate(() =>
      document
        .createElement("video")
        .canPlayType('video/mp4; codecs="avc1.64001f"'),
    );
    if (playable) {
      await page
        .locator(
          '.video-card[data-file-id="' + file.id + '"] .video-play-trigger',
        )
        .click();
      const frame = await page.waitForFunction(
        (id) => {
          const video = document.querySelector(
            '.video-card[data-file-id="' + id + '"] video',
          );
          if (!video || video.readyState < 2 || video.currentTime <= 0)
            return null;
          video.pause();
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const draw = canvas.getContext("2d");
          draw.drawImage(video, 0, 0);
          const pixels = draw.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let sum = 0;
          for (let i = 0; i < pixels.length; i += 4)
            sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
          return {
            width: video.videoWidth,
            height: video.videoHeight,
            mean: sum / (pixels.length * 0.75),
          };
        },
        file.id,
        { timeout: 15_000 },
      );
      const decoded = await frame.jsonValue();
      assert.equal(decoded.width, 1280);
      assert.equal(decoded.height, 720);
      assert.ok(decoded.mean > 40, "a frame with colour, mean " + decoded.mean);
      console.log("PASS the reduced MP4 plays back at 1280x720 in the browser");
    } else
      console.log("SKIP playback: this Chromium's <video> cannot play H.264");
    checked++;
    console.log(
      "PASS a 1600x900 WebM goes out as H.264 MP4 at 1280x720 with its sound (" +
        clip.length +
        " -> " +
        file.bytes +
        " bytes)",
    );
    await stage();
  } else
    console.log(
      "SKIP the reduced path: this Chromium has no H.264 encoder (fallback checked below)",
    );
  // Original quality: the WebM as is; the choice is restored afterwards.
  await original.check();
  await composer().fill("Original clip");
  await composer().press("Enter");
  const originals = await waitForFiles(checked + 1);
  const kept = originals.at(-1).files[0];
  assert.equal(kept.filename, "clip.webm");
  assert.equal(kept.media_type, "video/webm");
  assert.equal(Number(kept.bytes), clip.length);
  await stage();
  await original.uncheck();
  checked++;
  console.log("PASS the original-quality choice sends the video untouched");
  // No H.264 encoder: the preview says so and the original goes out.
  if (encodes) {
    await page.locator(".staged-chip .staged-remove").click();
    await page.locator(".staged-chip").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await context.close();
    ({ context, page, errors } = await open(() => {
      VideoEncoder.isConfigSupported = async (config) => ({
        supported: false,
        config,
      });
    }));
    await stage();
  }
  const note = page.locator(".staged-note");
  await note.waitFor();
  assert.equal(
    await note.textContent(),
    "This browser cannot reduce videos: they will be sent in original quality.",
  );
  await page.screenshot({
    path: "../../.cache/web-shots/web-video-no-reduction.png",
  });
  await composer().fill("Unreduced clip");
  await composer().press("Enter");
  const fallback = (await waitForFiles(checked + 1)).at(-1);
  assert.equal(fallback.files[0].filename, "clip.webm");
  assert.equal(fallback.files[0].media_type, "video/webm");
  assert.equal(fallback.text, "Unreduced clip");
  assert.deepEqual(errors, []);
  console.log(
    "PASS without an H.264 encoder the preview says so and the original is sent",
  );
} catch (error) {
  await page
    .screenshot({ path: "../../.cache/web-shots/video-reduce-failure.png" })
    .catch(() => {});
  console.log(
    "Video UI:",
    await page
      .locator(".toast")
      .allTextContents()
      .catch(() => []),
  );
  throw error;
} finally {
  await browser.close();
}
