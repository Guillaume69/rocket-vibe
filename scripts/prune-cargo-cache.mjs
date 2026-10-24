// Keep only what a CI cache of a Cargo build reuses: dependency artifacts.
// The repository's own crates are rebuilt from every fresh checkout anyway, and
// binaries, examples, incremental data and unpacked registry sources come back.
//   node scripts/prune-cargo-cache.mjs <Cargo.lock> <target dir> [<CARGO_HOME>]
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [lock, target, home] = process.argv.slice(2);
if (!lock || !target) {
  console.error('usage: node scripts/prune-cargo-cache.mjs <Cargo.lock> <target dir> [<CARGO_HOME>]');
  process.exit(2);
}
const local = new Set();
for (const block of readFileSync(lock, 'utf8').split('[[package]]').slice(1)) {
  const name = /^name = "(.+)"$/m.exec(block)?.[1];
  if (name && !/^source = /m.test(block)) local.add(name.replaceAll('-', '_'));
}
const owner = (entry) => entry.replace(/^lib/, '').replace(/-[0-9a-f]{16}(\..*)?$/, '').replaceAll('-', '_');
const ownerDir = (entry) => entry.replace(/-[0-9a-f]{16}$/, '').replaceAll('-', '_');
const remove = (path) => rmSync(path, { recursive: true, force: true });
const profiles = (directory, depth) => {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.some((entry) => entry.name === 'deps')) return [directory];
  return depth ? entries.flatMap((entry) => profiles(join(directory, entry.name), depth - 1)) : [];
};
for (const profile of profiles(target, 2)) {
  for (const entry of readdirSync(profile, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['examples', 'incremental'].includes(entry.name)) remove(join(profile, entry.name));
  }
  for (const entry of readdirSync(join(profile, 'deps'))) {
    if (local.has(owner(entry))) remove(join(profile, 'deps', entry));
  }
  for (const folder of ['.fingerprint', 'build']) {
    if (!existsSync(join(profile, folder))) continue;
    for (const entry of readdirSync(join(profile, folder))) {
      if (local.has(ownerDir(entry))) remove(join(profile, folder, entry));
    }
  }
}
if (home) for (const folder of ['registry/src', 'git/checkouts']) remove(join(home, folder));
