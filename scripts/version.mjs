// Each app's version, from the file that owns it.
//   node scripts/version.mjs mobile|desktop|server [--tag <git tag>]
// mobile: apps/mobile/app.json (expo.version), which package.json must match,
//   and android.versionCode = major * 10000 + minor * 100 + patch, so that
//   every release installs over the previous one.
// desktop: apps/desktop/Cargo.toml ([workspace.package] version).
// server: apps/server/Cargo.toml ([package] version), which the root
//   Cargo.lock's rv-server entry must match (CI builds with --locked). The web
//   client is compiled into the server and ships under its version.
// With --tag, the tag must be `<app>-v<version>`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [app, flag, tag] = process.argv.slice(2);

function fail(message) {
  console.error(`version: ${message}`);
  process.exit(1);
}

function mobile() {
  const expo = JSON.parse(readFileSync(join(ROOT, 'apps/mobile/app.json'), 'utf8')).expo;
  const pkg = JSON.parse(readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'));
  if (pkg.version !== expo.version) fail(`package.json ${pkg.version} ≠ app.json ${expo.version}`);
  const [major, minor, patch] = expo.version.split('.').map(Number);
  const code = major * 10000 + minor * 100 + patch;
  if (expo.android?.versionCode !== code) {
    fail(`app.json android.versionCode ${expo.android?.versionCode} ≠ ${code} for ${expo.version}`);
  }
  return expo.version;
}

function desktop() {
  const cargo = readFileSync(join(ROOT, 'apps/desktop/Cargo.toml'), 'utf8');
  const section = cargo.split(/^\[/m).find((s) => s.startsWith('workspace.package]'));
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) fail('no [workspace.package] version in apps/desktop/Cargo.toml');
  for (const path of ['apps/desktop/voice/Cargo.toml', 'apps/desktop/voice/screen-audio/Cargo.toml']) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    const own = source.split(/^\[/m).find((s) => s.startsWith('package]'))?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (own !== version) fail(`${path} ${own} != desktop ${version}`);
  }
  for (const [path, names] of [
    ['apps/desktop/Cargo.lock', ['rocket-vibe-gtk', 'rv-core', 'rv-ffi', 'rv-native', 'rv-voice-protocol']],
    ['apps/desktop/voice/Cargo.lock', ['rv-voice', 'rv-screen-audio', 'rv-voice-protocol']],
  ]) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    for (const name of names) {
      const own = source.match(new RegExp('name = "' + name + '"\\r?\\nversion = "([^"\\n]+)"'))?.[1];
      if (own !== version) fail(`${path} ${name} ${own} != desktop ${version}`);
    }
  }
  return version;
}

function server() {
  const cargo = readFileSync(join(ROOT, 'apps/server/Cargo.toml'), 'utf8');
  const section = cargo.split(/^\[/m).find((s) => s.startsWith('package]'));
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) fail('no [package] version in apps/server/Cargo.toml');
  const lock = readFileSync(join(ROOT, 'Cargo.lock'), 'utf8');
  const locked = lock.match(/name = "rv-server"\r?\nversion = "([^"]+)"/)?.[1];
  if (locked !== version) fail(`Cargo.lock rv-server ${locked} ≠ apps/server/Cargo.toml ${version}`);
  return version;
}

const versions = { mobile, desktop, server };
if (!(app in versions)) fail('usage: node scripts/version.mjs mobile|desktop|server [--tag <tag>]');
const version = versions[app]();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${version} is not major.minor.patch`);
if (flag === '--tag' && tag !== `${app}-v${version}`) fail(`tag ${tag} ≠ ${app}-v${version}`);
console.log(version);
