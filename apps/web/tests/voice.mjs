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
    "--auto-select-desktop-capture-source=Entire screen",
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
      window.__displayTracks = [];
      window.__displaySoundTracks = [];
      window.__voiceSenders = [];
      window.__toneGains = [];
      const microphone = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (options) => {
        const stream = await microphone(options);
        if (options.audio) {
          for (const track of stream.getAudioTracks()) {
            track.stop();
            stream.removeTrack(track);
          }
          const context = new AudioContext(),
            tone = context.createOscillator(),
            gain = context.createGain(),
            output = context.createMediaStreamDestination();
          gain.gain.value = 0.03;
          tone.connect(gain).connect(output);
          tone.start();
          window.__toneGains.push(gain);
          for (const track of output.stream.getAudioTracks())
            stream.addTrack(track);
        }
        return stream;
      };
      const display = navigator.mediaDevices.getDisplayMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getDisplayMedia = async (options) => {
        const stream = await display(options);
        window.__displayTracks.push(...stream.getVideoTracks());
        if (window.__verifiedShare) {
          // A controlled program-sound source exercises the verified-exclusion
          // branch. This fixture does not qualify browser loopback exclusion.
          for (const track of stream.getAudioTracks()) {
            track.stop();
            stream.removeTrack(track);
          }
          const context = new AudioContext(),
            tone = context.createOscillator(),
            gain = context.createGain(),
            output = context.createMediaStreamDestination();
          tone.frequency.value = 400;
          gain.gain.value = 0.02;
          tone.connect(gain).connect(output);
          tone.start();
          const track = output.stream.getAudioTracks()[0],
            settings = track.getSettings.bind(track);
          track.getSettings = () => ({ ...settings(), restrictOwnAudio: true });
          stream.addTrack(track);
        } else {
          for (const track of stream.getAudioTracks()) {
            const settings = track.getSettings.bind(track);
            track.getSettings = () => ({
              ...settings(),
              restrictOwnAudio: false,
            });
          }
        }
        window.__displaySoundTracks.push(...stream.getAudioTracks());
        return stream;
      };
      const transceiver = RTCPeerConnection.prototype.addTransceiver;
      RTCPeerConnection.prototype.addTransceiver = function (...args) {
        const result = transceiver.apply(this, args);
        window.__voiceSenders.push(result.sender);
        return result;
      };
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
  const otherRoom = await request("/api/v1/rooms", alice.token, {
    name: "voice-chat-" + crypto.randomUUID().slice(0, 8),
    private: false,
    voice: false,
    operation_id: crypto.randomUUID(),
  });
  await a
    .locator('[data-room="' + otherRoom.id + '"]')
    .first()
    .click();
  await a.locator(".voice-bar-info").click();
  await a.locator(".voice-page").waitFor();
  assert.equal(
    await a.locator(".room-row.selected").getAttribute("data-room"),
    room.id,
    "voice bar restores the actual call room",
  );
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
  const dropdownWidth = await audioMenu
    .getByLabel("Input device", { exact: true })
    .evaluate((select) => select.getBoundingClientRect().width);
  const menuWidth = await audioMenu.evaluate(
    (menu) => menu.getBoundingClientRect().width,
  );
  assert.ok(
    dropdownWidth >= menuWidth - 32,
    "GTK device chooser fills the audio menu",
  );
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
    .getByRole("button", { name: "Audio options", exact: true })
    .click();
  const whisperMenu = a.getByRole("dialog", {
    name: "Audio options",
    exact: true,
  });
  await setRange(whisperMenu.getByLabel("Input volume", { exact: true }), 100);
  await a.keyboard.press("Escape");
  await a.evaluate(() =>
    window.__toneGains.forEach((gain) => (gain.gain.value = 0.004)),
  );
  await a.waitForFunction(
    (uid) =>
      !document
        .querySelector('[data-participant="' + uid + '"]')
        ?.classList.contains("speaking"),
    alice.user.id,
  );
  await b.waitForFunction(
    (uid) =>
      document
        .querySelector('[data-participant="' + uid + '"]')
        ?.classList.contains("speaking"),
    alice.user.id,
  );
  await b.waitForTimeout(700);
  assert.equal(
    await b
      .locator('[data-participant="' + alice.user.id + '"].speaking')
      .count(),
    1,
  );
  await a.evaluate(() =>
    window.__toneGains.forEach((gain) => (gain.gain.value = 0)),
  );
  await b.waitForFunction(
    (uid) =>
      !document
        .querySelector('[data-participant="' + uid + '"]')
        ?.classList.contains("speaking"),
    alice.user.id,
  );
  await a.evaluate(() =>
    window.__toneGains.forEach((gain) => (gain.gain.value = 0.03)),
  );
  console.log(
    "PASS a quiet real RTP stream lights the GTK speaking halo and silence clears it after the hangover",
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
  let deafenedOnServer = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const live = await request("/api/v1/live", alice.token);
    deafenedOnServer =
      live.data.rooms
        .find((item) => item.room_id === room.id)
        ?.voice?.find((item) => item.user.id === alice.user.id)?.deafened ===
      true;
    if (deafenedOnServer) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(
    deafenedOnServer,
    "deafen uses the GTK and server participant attribute contract",
  );
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
  const picker = a.getByRole("dialog", {
    name: "Share your screen",
    exact: true,
  });
  assert.equal(
    await picker.getByLabel("Resolution", { exact: true }).inputValue(),
    "1080",
  );
  assert.equal(
    await picker.getByLabel("Frame rate", { exact: true }).inputValue(),
    "15",
  );
  await picker.getByRole("button", { name: "Share", exact: true }).click();
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
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  const actualShare = a.getByRole("dialog", {
    name: "Share your screen",
    exact: true,
  });
  await actualShare
    .getByLabel("Resolution", { exact: true })
    .selectOption("720");
  await actualShare
    .getByLabel("Frame rate", { exact: true })
    .selectOption("30");
  await a.screenshot({
    path: "../../.cache/web-shots/web-share-quality-reference.png",
  });
  await actualShare.getByRole("button", { name: "Share", exact: true }).click();
  await b.locator(".voice-screen-stage:not([hidden]) video").waitFor();
  await b.waitForFunction(() =>
    [...document.querySelectorAll(".voice-screen-stage video")].some(
      (video) =>
        video.videoWidth > 0 &&
        video.srcObject
          ?.getVideoTracks()
          .some((track) => track.readyState === "live"),
    ),
  );
  assert.equal(await b.locator(".voice-card.mini").count(), 2);
  await b.screenshot({
    path: "../../.cache/web-shots/web-share-stage-reference.png",
  });
  assert.equal(
    await b.locator('audio[data-voice-source="screen_share_audio"]').count(),
    0,
  );
  assert.ok(
    await a.evaluate(
      () =>
        window.__displaySoundTracks.length > 0 &&
        window.__displaySoundTracks.every(
          (track) => track.readyState === "ended",
        ),
    ),
    "unrestricted capture sound is stopped before publication",
  );
  const screenEvidence = await a.evaluate(() => ({
    tracks: window.__displayTracks.map((track) => track.getSettings()),
    encodings: window.__voiceSenders
      .filter((sender) => sender.track?.getSettings().displaySurface)
      .flatMap((sender) => sender.getParameters().encodings),
  }));
  assert.equal(screenEvidence.tracks[0].height, 720);
  assert.equal(screenEvidence.tracks[0].frameRate, 30);
  assert.ok(
    screenEvidence.encodings.some((encoding) => encoding.maxFramerate === 30),
    "selected cadence reaches the sender",
  );
  await b.locator(".voice-stage-full").click();
  await b.waitForFunction(() =>
    document.fullscreenElement?.classList.contains("voice-screen-stage"),
  );
  assert.equal(
    await b.locator(".voice-screen-stage .voice-controls").count(),
    0,
  );
  await b.locator(".voice-stage-full").click();
  await b.waitForFunction(() => !document.fullscreenElement);
  const includeCall = async (value) => {
    // The account block opens a menu: settings, administration, sign out.
    await a.getByRole("button", { name: "My account, settings and sign out", exact: true }).click();
    await a.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const settings = a.locator(".settings-dialog");
    await settings.getByRole("button", { name: "Voice", exact: true }).click();
    await settings
      .getByLabel("Include the call in a shared screen's sound", {
        exact: true,
      })
      .setChecked(value);
    await settings.locator(".preferences-close").click();
    await settings.waitFor({ state: "detached" });
  };
  const sharedRms = async () =>
    b.evaluate(async () => {
      const track = document
        .querySelector('audio[data-voice-source="screen_share_audio"]')
        .srcObject.getAudioTracks()[0];
      const context = new AudioContext(),
        source = context.createMediaStreamSource(new MediaStream([track])),
        analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const samples = new Float32Array(2048);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      source.disconnect();
      await context.close();
      return rms;
    });
  await includeCall(true);
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "attached" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    (await sharedRms()) > 0.001,
    "optional remote voices travel over the shared-sound RTP track",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Listen", exact: true })
    .click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    (await sharedRms()) < 0.0005,
    "deafened voices are excluded from the mix",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Listen", exact: true })
    .click();
  await includeCall(false);
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "detached" });
  console.log(
    "PASS shared sound rejects unverified browser loopback and opt-in call mixing respects deafen over real RTP",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  await b.locator(".voice-screen-stage").waitFor({ state: "hidden" });
  assert.equal(await b.locator(".voice-card.mini").count(), 0);
  console.log(
    "PASS real screen capture uses GTK quality choices, main share stage, participant strip and fullscreen exit",
  );
  await a.evaluate(() => {
    window.__verifiedShare = true;
  });
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  await a
    .getByRole("dialog", { name: "Share your screen", exact: true })
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "attached" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    (await sharedRms()) > 0.001,
    "verified program sound travels over actual RTC",
  );
  await a
    .locator(".voice-controls")
    .getByRole("button", { name: "Share the screen", exact: true })
    .click();
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "detached" });
  await b.locator(".voice-screen-stage").waitFor({ state: "hidden" });
  assert.ok(
    await a.evaluate(() =>
      window.__displaySoundTracks.every(
        (track) => track.readyState === "ended",
      ),
    ),
    "all capture-sound sources stop when sharing ends",
  );
  console.log(
    "PASS a controlled verified-exclusion program-sound fixture is processed before publication and cleaned up on stop",
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
  const shareScreen = async (page) => {
    await page
      .locator(".voice-controls")
      .getByRole("button", { name: "Share the screen", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Share your screen", exact: true })
      .getByRole("button", { name: "Share", exact: true })
      .click();
  };
  await shareScreen(a);
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "attached" });
  await b.locator(".voice-mini-strip .has-camera video").waitFor();
  assert.equal(
    await b.locator(".voice-mini-strip .has-camera .voice-avatar").isVisible(),
    false,
  );
  await a.waitForFunction(
    () =>
      document.querySelector('.voice-controls [aria-label="Share the screen"]')
        .disabled === false,
  );
  await a.locator(".voice-stage-full").click();
  await shareScreen(b);
  await a.waitForFunction(
    (username) =>
      document.querySelector(".voice-stage-label")?.textContent ===
      username + "'s screen",
    bob.user.display_name || bob.user.username,
  );
  await b
    .locator('audio[data-voice-source="screen_share_audio"]')
    .waitFor({ state: "detached" });
  await a.waitForFunction(() =>
    window.__displayTracks.every((track) => track.readyState === "ended"),
  );
  assert.equal(
    await a.evaluate(() =>
      document.fullscreenElement?.classList.contains("voice-screen-stage"),
    ),
    true,
    "fullscreen follows the takeover",
  );
  const takeover = await request("/api/v1/live", bob.token);
  const connected =
    takeover.data.rooms.find((item) => item.room_id === room.id)?.voice || [];
  assert.equal(connected.filter((person) => person.screen).length, 1);
  assert.equal(connected.find((person) => person.screen)?.user.id, bob.user.id);
  console.log(
    "PASS camera thumbnails and screen takeover stop the previous sound/capture while fullscreen follows the new sharer",
  );
  await b.evaluate(() => {
    const track = window.__displayTracks.at(-1);
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await b.locator(".voice-screen-stage").waitFor({ state: "hidden" });
  await a.waitForFunction(() => !document.fullscreenElement);
  await a.locator(".voice-screen-stage").waitFor({ state: "hidden" });
  assert.equal(
    await b
      .locator(".voice-controls")
      .getByRole("button", { name: "Share the screen", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  console.log(
    "PASS the browser's capture-ended event releases sharing, restores tiles and closes fullscreen",
  );
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
  // The account block opens a menu: settings, administration, sign out.
  await b.getByRole("button", { name: "My account, settings and sign out", exact: true }).click();
  await b.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await b.getByLabel("Username or email").waitFor();
  await b.getByLabel("Username or email").fill(aliceName);
  await b.getByLabel("Password", { exact: true }).fill(password);
  await b.getByRole("button", { name: "Sign in", exact: true }).click();
  await b.waitForFunction(
    () =>
      document.querySelector(".shell") ||
      document.querySelector(".login-error")?.textContent.trim(),
  );
  assert.equal(
    await b.locator(".login-error").count(),
    0,
    "the fixture must be able to create another browser device",
  );
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
  const failureUser = await request("/api/v1/auth/login", null, {
    username: process.env.RV_WEB_VOICE_FAILURE_USER || "webvoicefailure",
    password,
  });
  await request(
    "/api/v1/rooms/" + room.id + "/members/" + failureUser.user.id,
    alice.token,
    null,
  );
  const failedContext = await browser.newContext({
    permissions: ["microphone"],
    locale: "en-US",
  });
  contexts.push(failedContext);
  await failedContext.addInitScript(() => {
    window.__capturedMicrophones = [];
    window.__peakMicrophones = 0;
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await capture(options);
      window.__capturedMicrophones.push(...stream.getAudioTracks());
      window.__peakMicrophones = Math.max(
        window.__peakMicrophones,
        window.__capturedMicrophones.filter(
          (track) => track.enabled && track.readyState !== "ended",
        ).length,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      return stream;
    };
    AudioContext.prototype.createMediaStreamDestination = function () {
      throw new DOMException(
        "Synthetic microphone processor failure",
        "NotSupportedError",
      );
    };
  });
  const failurePage = await failedContext.newPage();
  pages.push(failurePage);
  await failurePage.goto(base);
  await failurePage
    .getByLabel("Username or email")
    .fill(failureUser.user.username);
  await failurePage.getByLabel("Password", { exact: true }).fill(password);
  await failurePage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await failurePage.locator(".status-dot.online").waitFor();
  await failurePage
    .locator('[data-room="' + room.id + '"]')
    .first()
    .click();
  await failurePage.locator(".voice-status.connected").waitFor();
  await failurePage
    .locator('.voice-controls [aria-label="Microphone"][aria-pressed="true"]')
    .waitFor();
  await failurePage.waitForFunction(
    () =>
      window.__capturedMicrophones.length > 0 &&
      window.__capturedMicrophones.every(
        (track) => !track.enabled || track.readyState === "ended",
      ),
  );
  await failurePage
    .locator(".voice-controls")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await failurePage
    .locator(".voice-bar")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await failurePage.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        '.voice-controls [aria-label="Microphone"],.voice-bar [aria-label="Microphone"]',
      ),
    ].every((button) => !button.disabled),
  );
  assert.equal(
    await failurePage.evaluate(() => window.__peakMicrophones),
    1,
    "concurrent microphone controls must serialize capture attempts",
  );
  await failurePage.waitForFunction(() =>
    window.__capturedMicrophones.every(
      (track) => !track.enabled || track.readyState === "ended",
    ),
  );
  await failurePage
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await failurePage.locator(".voice-bar").waitFor({ state: "detached" });
  console.log(
    "PASS a microphone processor failure really mutes capture before showing listening-only controls",
  );
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
