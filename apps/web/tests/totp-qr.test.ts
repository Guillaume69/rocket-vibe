import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIET_ZONE, qrPath, totpQr } from "../src/totp-qr.ts";

const uri =
  "otpauth://totp/RocketVibe-0a1b2c3d:ada?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=RocketVibe-0a1b2c3d&algorithm=SHA1&digits=6&period=30";

test("a setup link encodes to a version 8 symbol with a four-module quiet zone", () => {
  assert.equal(uri.length, 139);
  const qr = totpQr(uri)!;
  assert.equal(qr.version, 8);
  assert.equal(qr.size, 49 + 2 * QUIET_ZONE);
  assert.equal(qr.dark.length, qr.size);
  for (let i = 0; i < QUIET_ZONE; i++) {
    for (const row of [qr.dark[i], qr.dark[qr.size - 1 - i]])
      assert.ok(row.every((module) => !module));
    assert.ok(qr.dark.every((row) => !row[i] && !row[qr.size - 1 - i]));
  }
  const finder = qr.dark
    .slice(QUIET_ZONE, QUIET_ZONE + 7)
    .map((row) => row.slice(QUIET_ZONE, QUIET_ZONE + 7));
  assert.deepEqual(
    finder.map((row) => row.map(Number).join("")),
    [
      "1111111",
      "1000001",
      "1011101",
      "1011101",
      "1011101",
      "1000001",
      "1111111",
    ],
  );
});

test("only otpauth TOTP links are drawn", () => {
  assert.equal(totpQr("https://example.com/"), null);
  assert.equal(totpQr("otpauth://hotp/x?secret=A"), null);
});

test("the path draws one rectangle per run of dark modules", () => {
  assert.equal(
    qrPath({
      version: 1,
      size: 4,
      dark: [
        [true, true, false, true],
        [false, false, false, false],
        [false, true, true, true],
        [true, false, false, false],
      ],
    }),
    "M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3zM0 3h1v1h-1z",
  );
});
