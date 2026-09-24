#!/usr/bin/env node
// Generates crates/rv-core/data/emojis.tsv from emoji-toolkit's JSON (MIT; its
// artwork is not used), the source Rocket.Chat takes its shortnames from.
//   node scripts/generate-emojis.mjs [path/to/emoji-toolkit]
// Rows: shortcode <TAB> code points (hex, dash-separated) <TAB> picker category
// ("-" for tone variants and aliases). Deterministic: rerunning on the same
// version leaves git diff empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolkit = process.argv[2] ?? join(root, '..', 'rocket-vibe', 'node_modules', 'emoji-toolkit');
const emojis = JSON.parse(readFileSync(join(toolkit, 'emoji.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(toolkit, 'package.json'), 'utf8')).version;
const CATEGORIES = ['people', 'nature', 'food', 'activity', 'travel', 'objects', 'symbols', 'flags'];

const rows = new Map();
const entries = Object.entries(emojis).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
for (const [hex, e] of entries) {
  if (e.display !== 1) continue;
  const points = e.code_points?.fully_qualified || e.code_points?.base || hex;
  const base = CATEGORIES.includes(e.category) && !/_tone\d/.test(e.shortname);
  [e.shortname, ...(e.shortname_alternates ?? [])].forEach((name, i) => {
    const code = name.slice(1, -1);
    if (!rows.has(code)) rows.set(code, [points, base && i === 0 ? e.category : '-']);
  });
}
const lines = [...rows].map(([code, [points, category]]) => `${code}\t${points}\t${category}`);
writeFileSync(join(root, 'crates/rv-core/data/emojis.tsv'), lines.join('\n') + '\n');
console.log(`emojis.tsv: ${rows.size} shortcodes, ${lines.filter((l) => !l.endsWith('\t-')).length} in the picker (emoji-toolkit ${version})`);
