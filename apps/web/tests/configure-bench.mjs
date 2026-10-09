import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import assert from "node:assert/strict";
// Disposable local fixture only. These credentials never configure a deployment.
const sfuIp = process.env.RV_WEB_SFU_IP || "127.0.0.1";
assert.equal(isIP(sfuIp), 4, "The isolated SFU needs an explicit IPv4 address");
const privateMode = { mode: 0o600 };
mkdirSync(".cache", { recursive: true });
if (!existsSync(".cache/auth-key"))
  writeFileSync(".cache/auth-key", randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
writeFileSync(
  ".cache/smtp.json",
  JSON.stringify({
    host: "localhost",
    port: 14653,
    from: "service@example.test",
    tls: "implicit_tls",
    ca_file: resolve("apps/server/tests/fixtures/mail-cert.pem"),
  }),
  privateMode,
);
writeFileSync(
  ".cache/livekit.json",
  JSON.stringify({
    url: "ws://127.0.0.1:17880",
    api_url: "http://127.0.0.1:17880",
    api_key: "webtest",
    api_secret: "web-disposable-sfu-secret-32-characters",
  }),
  privateMode,
);
writeFileSync(
  ".cache/livekit.yaml",
  "port: 17880\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  use_external_ip: false\n  node_ip: " +
    sfuIp +
    "\nkeys:\n  webtest: web-disposable-sfu-secret-32-characters\n",
  privateMode,
);
if (process.platform !== "win32")
  for (const path of [
    ".cache/auth-key",
    ".cache/smtp.json",
    ".cache/livekit.json",
    ".cache/livekit.yaml",
  ])
    chmodSync(path, 0o600);
