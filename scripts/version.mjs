// Each app's version, from the file that owns it.
//   node scripts/version.mjs mobile|desktop [--tag <git tag>]
// mobile: apps/mobile/app.json (expo.version), which package.json must match,
//   and android.versionCode = major * 10000 + minor * 100 + patch, so that
//   every release installs over the previous one.
// desktop: apps/desktop/Cargo.toml ([workspace.package] version).
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
  return version;
}

const versions = { mobile, desktop };
if (!(app in versions)) fail('usage: node scripts/version.mjs mobile|desktop [--tag <tag>]');
const version = versions[app]();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${version} is not major.minor.patch`);
if (flag === '--tag' && tag !== `${app}-v${version}`) fail(`tag ${tag} ≠ ${app}-v${version}`);
console.log(version);
