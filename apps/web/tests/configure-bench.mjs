import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
// Disposable loopback fixture only. These credentials never configure a deployment.
mkdirSync(".cache", { recursive: true });
if (!existsSync(".cache/auth-key"))
  writeFileSync(".cache/auth-key", randomBytes(32).toString("hex"));
writeFileSync(
  ".cache/smtp.json",
  JSON.stringify({
    host: "localhost",
    port: 14653,
    from: "service@example.test",
    tls: "implicit_tls",
    ca_file: resolve("apps/server/tests/fixtures/mail-cert.pem"),
  }),
);
writeFileSync(
  ".cache/livekit.json",
  JSON.stringify({
    url: "ws://127.0.0.1:17880",
    api_url: "http://127.0.0.1:17880",
    api_key: "webtest",
    api_secret: "web-disposable-sfu-secret-32-characters",
  }),
);
writeFileSync(
  ".cache/livekit.yaml",
  "port: 17880\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  webtest: web-disposable-sfu-secret-32-characters\n",
);
