#!/usr/bin/env node
/**
 * Génère le bundle serveur Rocket.Chat patché pour le push, à monter en volume.
 *
 *   node docker/patch-push.mjs              # image lue dans docker/compose.yml
 *   node docker/patch-push.mjs <image:tag>  # image explicite (serveur de prod)
 *
 * Écrit `docker/patched/app-<tag>.js`. Le compose monte ce fichier par son tag :
 * changer RC_VERSION sans relancer ce script fait échouer le démarrage, au lieu
 * de monter un bundle d'une autre version.
 *
 * Deux retouches, chacune ancrée sur un extrait exact qui doit apparaître UNE
 * fois, sinon le script s'arrête sans rien écrire :
 *
 * 1. Routage par application : le gateway reste en service pour les applis
 *    officielles, nos jetons (`appName` = APP_NAME de lib/pushToken.ts) passent
 *    en natif, par nos identifiants Firebase. Sans ça, le choix est global au
 *    serveur, et le natif fait supprimer les jetons des applis officielles
 *    (SENDER_ID_MISMATCH).
 * 2. Bloc `apns` dans le message FCM : `mutable-content` réveille la
 *    Notification Service Extension iOS, `thread-id` groupe par salon.
 *
 * Les remplacements gardent le nombre de lignes : `app.js.map` reste aligné.
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
    nom: 'routage gateway par application',
    avant: `            if (this.shouldUseGateway()) {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
    apres: `            if (this.shouldUseGateway() && app.appName !== '${APP_NAME}') {
                await this.sendNotificationGateway(app, notification, countApn, countGcm);`,
  },
  {
    nom: 'bloc apns du message FCM',
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
  if (typeof image !== 'string') throw new Error('service rocketchat sans image dans le compose');
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
      throw new Error(`« ${nom} » : ancre trouvée ${occurrences} fois (attendu : 1). Le code a changé, revoir la retouche.`);
    }
    if (avant.split('\n').length !== apres.split('\n').length) {
      throw new Error(`« ${nom} » : le remplacement change le nombre de lignes.`);
    }
    resultat = resultat.replace(avant, () => apres);
  }
  return resultat;
}

const image = process.argv[2] ?? imageDuCompose();
const tag = image.slice(image.lastIndexOf(':') + 1);
if (tag === '' || tag.includes('/')) throw new Error(`image sans tag : ${image}`);

console.log(`image : ${image}`);
garantirImage(image);
const patche = retoucher(extraireBundle(image));

const sortie = join(ici, 'patched', `app-${tag}.js`);
mkdirSync(dirname(sortie), { recursive: true });
writeFileSync(sortie, patche);
execFileSync(process.execPath, ['--check', sortie], { stdio: 'inherit' });
console.log(`écrit : ${sortie}`);
