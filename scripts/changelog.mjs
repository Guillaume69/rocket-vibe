// A version's section of an app's changelog, for its release notes.
//   node scripts/changelog.mjs mobile|desktop|vibez <version>
// Fails when the changelog has no section for that version: a release
// without its entry is a mistake worth stopping for.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [app, version] = process.argv.slice(2);

function fail(message) {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

if (!['mobile', 'desktop', 'vibez'].includes(app) || !version) fail('usage: node scripts/changelog.mjs mobile|desktop|vibez <version>');
const dir = app === 'vibez' ? 'server' : app;
const text = readFileSync(join(ROOT, 'apps', dir, 'CHANGELOG.md'), 'utf8');
const lines = text.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) fail(`apps/${dir}/CHANGELOG.md has no "## [${version}]" section`);
const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith('## ') || /^\[[^\]]+\]: /.test(l));
const section = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
if (!section) fail(`the ${version} section of apps/${dir}/CHANGELOG.md is empty`);
console.log(section);
