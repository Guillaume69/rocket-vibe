#!/usr/bin/env node
/**
 * Generates the Rocket.Chat server bundle patched for push, to mount as a volume.
 *
 *   node docker/patch-push.mjs              # image read from docker/compose.yml
 *   node docker/patch-push.mjs <image:tag>  # explicit image (prod server)
 *
 * Writes `docker/patched/app-<tag>.js`. The compose file mounts it by its tag:
 * changing RC_VERSION without rerunning this script makes startup fail, instead
 * of mounting a bundle from another version.
 *
 * Two patches, each anchored on an exact excerpt that must appear ONCE,
 * otherwise the script stops without writing anything:
 *
 * 1. Per-app routing: the gateway stays in service for the official apps, our
 *    tokens (`appName` = APP_NAME from lib/pushToken.ts) go native, through our
 *    Firebase credentials. Without it, the choice is server-wide, and native
 *    gets the official apps' tokens deleted (SENDER_ID_MISMATCH).
 * 2. `apns` block in the FCM message: `mutable-content` wakes the iOS
 *    Notification Service Extension, `thread-id` groups by room.
 *
 * The replacements keep the line count: `app.js.map` stays aligned.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'rocket-vibe';
const BUNDLE = '/app/bundle/programs/server/app/app.js';
const here = dirname(fileURLToPath(import.meta.url));

const PATCHES = [
  {
    name: 'per-app gateway routing',
    before: `            if (this.shouldUseGateway()) {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
    after: `            if (this.shouldUseGateway() && app.appName !== '${APP_NAME}') {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
  },
  {
    name: 'apns block of the FCM message',
    before: `        data,
        android: {
            priority: 'HIGH'
        }
    };`,
    after: `        data,
        apns: { payload: { aps: { 'mutable-content': 1, ...notification.notId && { 'thread-id': String(notification.notId) } } } },
        android: {
            priority: 'HIGH' }
    };`,
  },
];

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function composeImage() {
  const config = JSON.parse(docker('compose', '--project-directory', here, 'config', '--format', 'json'));
  const image = config.services?.rocketchat?.image;
  if (typeof image !== 'string') throw new Error('rocketchat service without an image in the compose file');
  return image;
}

function ensureImage(image) {
  try {
    docker('image', 'inspect', image);
  } catch {
    docker('pull', image);
  }
}

function extractBundle(image) {
  const container = docker('create', image);
  const dir = mkdtempSync(join(tmpdir(), 'rc-bundle-'));
  try {
    docker('cp', `${container}:${BUNDLE}`, join(dir, 'app.js'));
    return readFileSync(join(dir, 'app.js'), 'utf8');
  } finally {
    docker('rm', container);
    rmSync(dir, { recursive: true, force: true });
  }
}

function patch(source) {
  let result = source;
  for (const { name, before, after } of PATCHES) {
    const occurrences = result.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`"${name}": anchor found ${occurrences} times (expected: 1). The code changed, review the patch.`);
    }
    if (before.split('\n').length !== after.split('\n').length) {
      throw new Error(`"${name}": the replacement changes the line count.`);
    }
    result = result.replace(before, () => after);
  }
  return result;
}

const image = process.argv[2] ?? composeImage();
const tag = image.slice(image.lastIndexOf(':') + 1);
if (tag === '' || tag.includes('/')) throw new Error(`image without a tag: ${image}`);

console.log(`image: ${image}`);
ensureImage(image);
const patched = patch(extractBundle(image));

const output = join(here, 'patched', `app-${tag}.js`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, patched);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`written: ${output}`);
