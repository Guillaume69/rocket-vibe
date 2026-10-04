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
const ici = dirname(fileURLToPath(import.meta.url));

const RETOUCHES = [
  {
    nom: 'per-app gateway routing',
    avant: `            if (this.shouldUseGateway()) {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
    apres: `            if (this.shouldUseGateway() && app.appName !== '${APP_NAME}') {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
  },
  {
    nom: 'apns block of the FCM message',
    avant: `        data,
        android: {
            priority: 'HIGH'
        }
    };`,
    apres: `        data,
        apns: { payload: { aps: { 'mutable-content': 1, ...notification.notId && { 'thread-id': String(notification.notId) } } } },
        android: {
            priority: 'HIGH' }
    };`,
  },
];

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function imageDuCompose() {
  const config = JSON.parse(docker('compose', '--project-directory', ici, 'config', '--format', 'json'));
  const image = config.services?.rocketchat?.image;
  if (typeof image !== 'string') throw new Error('rocketchat service without an image in the compose file');
  return image;
}

function garantirImage(image) {
  try {
    docker('image', 'inspect', image);
  } catch {
    docker('pull', image);
  }
}

function extraireBundle(image) {
  const conteneur = docker('create', image);
  const dossier = mkdtempSync(join(tmpdir(), 'rc-bundle-'));
  try {
    docker('cp', `${conteneur}:${BUNDLE}`, join(dossier, 'app.js'));
    return readFileSync(join(dossier, 'app.js'), 'utf8');
  } finally {
    docker('rm', conteneur);
    rmSync(dossier, { recursive: true, force: true });
  }
}

function retoucher(source) {
  let resultat = source;
  for (const { nom, avant, apres } of RETOUCHES) {
    const occurrences = resultat.split(avant).length - 1;
    if (occurrences !== 1) {
      throw new Error(`"${nom}": anchor found ${occurrences} times (expected: 1). The code changed, review the patch.`);
    }
    if (avant.split('\n').length !== apres.split('\n').length) {
      throw new Error(`"${nom}": the replacement changes the line count.`);
    }
    resultat = resultat.replace(avant, () => apres);
  }
  return resultat;
}

const image = process.argv[2] ?? imageDuCompose();
const tag = image.slice(image.lastIndexOf(':') + 1);
if (tag === '' || tag.includes('/')) throw new Error(`image without a tag: ${image}`);

console.log(`image: ${image}`);
garantirImage(image);
const patche = retoucher(extraireBundle(image));

const sortie = join(ici, 'patched', `app-${tag}.js`);
mkdirSync(dirname(sortie), { recursive: true });
writeFileSync(sortie, patche);
execFileSync(process.execPath, ['--check', sortie], { stdio: 'inherit' });
console.log(`written: ${sortie}`);
