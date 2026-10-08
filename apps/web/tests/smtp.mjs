import tls from "node:tls";
import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
// PUBLIC synthetic certificate/key already used by server tests. Loopback only.
const key = createPrivateKey({
  key: readFileSync("apps/server/tests/fixtures/mail-key.der"),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" });
mkdirSync(".cache", { recursive: true });
const messages = [];
const server = tls.createServer(
  { key, cert: readFileSync("apps/server/tests/fixtures/mail-cert.pem") },
  (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost RocketVibe fixture\r\n");
    let buffer = "",
      data = false,
      content = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n"),
          line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(content);
            writeFileSync(".cache/smtp-mails.json", JSON.stringify(messages));
            content = "";
            socket.write("250 queued\r\n");
          } else content += line + "\n";
          continue;
        }
        if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250-8BITMIME\r\n250 PIPELINING\r\n");
        else if (/^MAIL FROM:|^RCPT TO:|^RSET|^NOOP/.test(line))
          socket.write("250 OK\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 Continue\r\n");
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  },
);
server.listen(14653, "127.0.0.1", () =>
  console.log("Disposable TLS SMTP fixture ready on loopback"),
);
