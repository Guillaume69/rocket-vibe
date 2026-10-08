import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.RV_WEB_TEST_URL || "http://127.0.0.1:3417";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
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
    username: "webalice",
    password,
  }),
  bob = await request("/api/v1/auth/login", null, {
    username: "webbob",
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
  for (const username of ["webalice", "webbob"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ["microphone", "camera"],
      locale: "en-US",
    });
    contexts.push(context);
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
    if (!(await page.locator(".voice-dialog").count()))
      await page
        .getByRole("button", { name: "Join call", exact: true })
        .click();
    await page.locator(".voice-dialog").waitFor({ timeout: 30000 });
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
  await a.locator(".voice-dialog .dialog-header button").click();
  await a
    .locator(".voice-bar")
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
    .locator(".voice-bar")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await a.waitForFunction(() => document.querySelector(".voice-bar .muted"));
  console.log("PASS microphone mute control");
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await a.locator(".voice-bar").waitFor({ state: "detached" });
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  await a.locator(".voice-dialog").waitFor();
  console.log("PASS leave and rejoin with fresh media resources");
  await a.locator(".voice-dialog .dialog-header button").click();
  await a
    .locator(".voice-bar")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await b.locator(".voice-dialog .dialog-header button").click();
  await b
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
