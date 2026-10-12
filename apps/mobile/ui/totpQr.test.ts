import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QUIET_ZONE, qrRuns, totpQr } from './totpQr.ts';

const uri =
  'otpauth://totp/RocketVibe-0a1b2c3d:ada?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=RocketVibe-0a1b2c3d&algorithm=SHA1&digits=6&period=30';

test('a setup link encodes to a version 8 symbol with a four-module quiet zone', () => {
  assert.equal(uri.length, 139);
  const qr = totpQr(uri)!;
  assert.equal(qr.version, 8);
  assert.equal(qr.size, 49 + 2 * QUIET_ZONE);
  for (let i = 0; i < QUIET_ZONE; i++) {
    assert.ok(qr.dark[i].every(module => !module));
    assert.ok(qr.dark[qr.size - 1 - i].every(module => !module));
    assert.ok(qr.dark.every(row => !row[i] && !row[qr.size - 1 - i]));
  }
  const finder = qr.dark.slice(QUIET_ZONE, QUIET_ZONE + 7).map(row => row.slice(QUIET_ZONE, QUIET_ZONE + 7).map(Number).join(''));
  assert.deepEqual(finder, ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']);
});

test('only otpauth TOTP links are drawn', () => {
  assert.equal(totpQr('https://example.com/'), null);
  assert.equal(totpQr('otpauth://hotp/x?secret=A'), null);
});

test('runs cover every dark module exactly once', () => {
  assert.deepEqual(
    qrRuns({ version: 1, size: 4, dark: [[true, true, false, true], [false, false, false, false], [false, true, true, true], [true, false, false, false]] }),
    [{ x: 0, y: 0, length: 2 }, { x: 3, y: 0, length: 1 }, { x: 1, y: 2, length: 3 }, { x: 0, y: 3, length: 1 }],
  );
  const qr = totpQr(uri)!;
  const covered = qrRuns(qr).reduce((sum, run) => sum + run.length, 0);
  assert.equal(covered, qr.dark.flat().filter(Boolean).length);
});
