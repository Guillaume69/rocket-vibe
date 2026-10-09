import assert from "node:assert/strict";
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  base,
  fixture,
  identity,
  groupDialog,
  pin,
  closeDialog,
} from "./crypto-browser.mjs";

assert.equal(base, "http://127.0.0.1:3417", "Dedicated disposable server only");
const root = resolve("../.."),
  tag = Date.now().toString(36);
const folder = resolve(root, ".cache/bench/gtk-" + tag);
const mounted = "/workspace/.cache/bench/gtk-" + tag;
const names = ["webgtk" + tag, "gtkweb" + tag];
assert.equal(
  execFileSync(
    "docker",
    [
      "inspect",
      "-f",
      '{{ index .Config.Labels "rocketvibe.task" }}',
      "rv-web-e2ee-api",
    ],
    { encoding: "utf8" },
  ).trim(),
  "web-e2ee",
);
await mkdir(folder, { recursive: true });
for (const name of names)
  execFileSync(
    "docker",
    [
      "exec",
      "-e",
      "RV_USER_PASSWORD=web-client-disposable-password",
      "rv-web-e2ee-api",
      ".cache/server-target/debug/rv-server",
      "create-user",
      name,
      "--admin",
    ],
    { stdio: "pipe" },
  );
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ locale: "en-US" })).newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let child,
  complete,
  log = "";
const container = "rv-web-e2ee-gtk-" + tag;
const shellQuote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const gtkSession = `mkdir -p "$HOME"; export XDG_RUNTIME_DIR="$HOME/runtime"; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"; Xvfb :98 -screen 0 1280x900x24 >/dev/null 2>&1 & display_pid=$!; trap 'kill "$display_pid" 2>/dev/null || true' EXIT; sleep 1; export GDK_BACKEND=x11 DISPLAY=:98 GSK_RENDERER=cairo GTK_A11Y=none; dbus-run-session -- bash -ec 'printf "\\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null; exec target/debug/rocket-vibe-gtk'`;
async function marker(name) {
  for (let i = 0; i < 1200; i++) {
    try {
      return await readFile(resolve(folder, name), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (complete) throw Error("GTK exited before " + name + "\n" + log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("GTK marker timed out: " + name + "\n" + log);
}
try {
  const fingerprint = await identity(page, names[0]);
  const users = await fixture(page, "/api/v1/users");
  const peer = users.find((user) => user.username === names[1]);
  const own = await fixture(page, "/api/v1/me");
  assert.ok(peer, "Disposable desktop user is visible");
  const room = await fixture(page, "/api/v1/rooms", "POST", {
    operation_id: crypto.randomUUID(),
    name: "web-gtk-" + tag,
    private: true,
  });
  await groupDialog(page, room.id);
  for (const name of [
    "Prepare this device for invitations",
    "Review group creation",
    "Confirm this review",
  ])
    await page.getByRole("button", { name, exact: true }).click();
  await page
    .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
    .waitFor();
  await page
    .getByText("Group recorded on this device", { exact: true })
    .waitFor();
  await closeDialog(page);
  await closeDialog(page);
  const input = page.locator(".room-content .rich-composer");
  await input.fill("Browser before desktop admission");
  await input.press("Enter");
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: "Browser before desktop admission" })
    .waitFor();
  await fixture(
    page,
    "/api/v1/rooms/" + room.id + "/members/" + peer.id,
    "POST",
    null,
  );
  await writeFile(
    resolve(folder, "fixture.json"),
    JSON.stringify({ room: room.id, peer: own.id, fingerprint }),
  );
  child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      container,
      "--label",
      "rocketvibe.task=web-e2ee",
      "-v",
      root + ":/workspace",
      "-v",
      "rv-cargo:/cargo",
      "-w",
      "/workspace/apps/desktop",
      "-e",
      "HOME=/tmp/rv-web-gtk-home",
      "-e",
      "RV_SMOKE_NATIVE=1",
      "-e",
      "RV_SMOKE_LOGIN=http://host.docker.internal:3417|" +
        names[1] +
        "|web-client-disposable-password",
      "-e",
      "RV_SMOKE_WEB_CRYPTO=" + mounted,
      "-e",
      "LANG=en_US.UTF-8",
      "rocket-vibe-rs-build",
      "bash",
      "-ec",
      'useradd -u 1000 -d "$HOME" -M rv-web-gtk; mkdir -p "$HOME"; chown 1000:1000 "$HOME"; exec runuser -u rv-web-gtk -p -- bash -ec ' +
        shellQuote(gtkSession),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      complete = true;
      resolve({ code, signal });
    });
  });
  const ready = JSON.parse(await marker("ready.json"));
  await pin(page, names[1], ready.fingerprint);
  await groupDialog(page, room.id);
  await page
    .getByRole("button", { name: "Review device changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm this review", exact: true })
    .click();
  await page
    .locator('.crypto-group-dialog .dialog-body[aria-busy="false"]')
    .waitFor();
  await closeDialog(page);
  await closeDialog(page);
  await marker("admitted");
  await input.fill("Private browser to GTK");
  await input.press("Enter");
  await page
    .locator(".timeline .message-body")
    .filter({ hasText: "Private GTK to browser" })
    .waitFor({ timeout: 90000 });
  console.log(
    "PASS real GTK timeline decrypts browser MLS and its existing composer encrypts the reply",
  );
  await input.fill("Browser confirms GTK decryption");
  await input.press("Enter");
  await marker("passed");
  const result = await exited;
  assert.equal(result.code, 0, log);
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.ok(
    !/Keychain (write failed|write timed out|did not answer)/.test(log),
    log,
  );
  console.log(
    "PASS browser/GTK admission, verified fingerprints, actual Secret Service and pre-admission isolation",
  );
} finally {
  await browser.close();
  if (child && !complete) {
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
    execFileSync("docker", ["stop", "--time", "2", container], {
      stdio: "pipe",
    });
  }
  await writeFile(resolve(folder, "gtk.log"), log);
}
