// One version per compatible line across every Cargo.lock of the repository.
//   node scripts/cargo-locks.mjs           check (CI): exit 1 on a drift
//   node scripts/cargo-locks.mjs --sync    raise each lagging lock to the newest
//                                          version another lock already uses
// The Rust code lives in separate workspaces on purpose (the voice sidecar
// keeps libwebrtc out of `cargo build --workspace`, rv-crypto-web has its own
// wasm release profile, the Android libraries build apart), so each has its
// own lock. Several majors of a crate may coexist when dependencies demand
// them (sha2 0.10 and 0.11); within one semver-compatible line (`1.x`,
// `0.29.x`) every lock must agree, or a fix reaches one app and not another.
// After a `cargo update` anywhere, run --sync, then commit every lock.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sync = process.argv.includes('--sync');

function locks() {
  return execFileSync('git', ['ls-files', '--', 'Cargo.lock', '**/Cargo.lock'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

/** Registry and git packages of a lock (workspace members have no source). */
function packages(lock) {
  const found = [];
  for (const block of readFileSync(join(ROOT, lock), 'utf8').split('[[package]]').slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]*)"`, 'm'))?.[1];
    const [name, version, source] = [field('name'), field('version'), field('source')];
    if (name && version && source) found.push({ name, version });
  }
  return found;
}

/** The semver-compatible line: the major, or `0.minor` below 1.0. */
function line(version) {
  const [major, minor = '0'] = version.split(/[+-]/)[0].split('.');
  return major === '0' ? `0.${minor}` : major;
}

function compare(a, b) {
  const parts = (v) => v.split(/[+-]/)[0].split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return a.localeCompare(b);
}

/** Lines used at more than one version: `name line` -> version -> locks. */
function drifts() {
  const seen = new Map();
  for (const lock of locks()) {
    for (const { name, version } of packages(lock)) {
      const key = `${name} ${line(version)}`;
      if (!seen.has(key)) seen.set(key, new Map());
      const versions = seen.get(key);
      if (!versions.has(version)) versions.set(version, new Set());
      versions.get(version).add(lock);
    }
  }
  return [...seen].filter(([, versions]) => versions.size > 1).sort(([a], [b]) => a.localeCompare(b));
}

function report(found) {
  for (const [key, versions] of found) {
    const where = [...versions]
      .sort(([a], [b]) => compare(a, b))
      .map(([version, in_]) => `${version} (${[...in_].join(', ')})`);
    console.error(`  ${key}: ${where.join('; ')}`);
  }
}

if (!sync) {
  const found = drifts();
  if (found.length > 0) {
    console.error(`cargo-locks: ${found.length} crate line(s) resolve to several versions:`);
    report(found);
    console.error('Align them: node scripts/cargo-locks.mjs --sync');
    process.exit(1);
  }
  console.log(`cargo-locks: ${locks().length} locks agree`);
  process.exit(0);
}

function cargoUpdate(lock, args) {
  const manifest = join(ROOT, dirname(lock), 'Cargo.toml');
  try {
    execFileSync('cargo', ['update', '--manifest-path', manifest, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// --sync: a raise can pull other crates along (thiserror-impl with
// thiserror), so drifts are recomputed every round until none is left.
for (let round = 1; round <= 6; round++) {
  const found = drifts();
  if (found.length === 0) {
    console.log('cargo-locks: every lock agrees');
    process.exit(0);
  }
  // Per lock, what lags behind: name@version -> the newest version in use.
  const lagging = new Map();
  for (const [key, versions] of found) {
    const name = key.split(' ')[0];
    const newest = [...versions.keys()].sort(compare).at(-1);
    for (const [version, in_] of versions) {
      if (version === newest) continue;
      for (const lock of in_) {
        if (!lagging.has(lock)) lagging.set(lock, []);
        lagging.get(lock).push({ name, version, newest });
      }
    }
  }
  for (const [lock, crates] of lagging) {
    const refused = crates.filter(({ name, version, newest }) => {
      const done = cargoUpdate(lock, ['-p', `${name}@${version}`, '--precise', newest]);
      if (done) console.log(`${lock}: ${name} ${version} -> ${newest}`);
      return !done;
    });
    // Crates that only move together (wasm-bindgen, js-sys, web-sys): one
    // update for all of them, to their newest compatible versions. If that
    // overshoots the other locks, the next round raises those.
    if (refused.length > 1) {
      const args = refused.flatMap(({ name, version }) => ['-p', `${name}@${version}`]);
      if (cargoUpdate(lock, args)) console.log(`${lock}: ${refused.map((c) => c.name).join(', ')} raised together`);
    }
  }
}
console.error('cargo-locks: still drifting (a `=` pin or a dependency constraint holds a lock back):');
report(drifts());
process.exit(1);
