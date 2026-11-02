// Renders the server rail's provider tiles from the brand marks in
// scripts/brand-tiles/ (sources and terms in its NOTICE.md): a one-colour
// Simple Icons glyph in white on its brand colour, a multi-colour logo on
// white. Needs rsvg-convert.
//   node scripts/generate-brand-tiles.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = join(root, 'scripts/brand-tiles');
const outputs = [join(root, 'apps/desktop/crates/rv-core/assets/brands'), join(root, 'apps/mobile/assets/brands')];
const SIDE = 128;

const TILES = [
  { name: 'rocketchat', svg: 'rocketdotchat.svg', glyph: '#FFFFFF', background: '#F5455C' },
  { name: 'mattermost', svg: 'mattermost.svg', glyph: '#FFFFFF', background: '#0058CC' },
  { name: 'kchat', svg: 'infomaniak.svg', glyph: '#FFFFFF', background: '#0098FF' },
  { name: 'whatsapp', svg: 'whatsapp.svg', glyph: '#FFFFFF', background: '#25D366' },
  { name: 'slack', svg: 'slack.svg', background: '#FFFFFF' },
  { name: 'teams', svg: 'microsoftteams.svg', background: '#FFFFFF' },
];

function inner(svg) {
  const open = svg.match(/<svg\b[^>]*>/);
  const viewBox = open[0].match(/viewBox="([^"]+)"/)?.[1]
    ?? `0 0 ${open[0].match(/width="([\d.]+)"/)[1]} ${open[0].match(/height="([\d.]+)"/)[1]}`;
  return { viewBox: viewBox.split(/[\s,]+/).map(Number), body: svg.slice(open.index + open[0].length, svg.lastIndexOf('</svg>')) };
}

function tile({ svg, glyph, background }) {
  const { viewBox: [x, y, w, h], body } = inner(readFileSync(join(sources, svg), 'utf8'));
  const box = SIDE * 0.62;
  const scale = box / Math.max(w, h);
  const dx = (SIDE - w * scale) / 2 - x * scale;
  const dy = (SIDE - h * scale) / 2 - y * scale;
  const fill = glyph ? ` fill="${glyph}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="0 0 ${SIDE} ${SIDE}">`
    + `<rect width="${SIDE}" height="${SIDE}" fill="${background}"/>`
    + `<g transform="translate(${dx} ${dy}) scale(${scale})"${fill}>${body}</g></svg>`;
}

for (const out of outputs) mkdirSync(out, { recursive: true });
for (const one of TILES) {
  const png = execFileSync('rsvg-convert', ['-w', String(SIDE), '-h', String(SIDE), '-f', 'png'], { input: tile(one) });
  for (const out of outputs) writeFileSync(join(out, `${one.name}.png`), png);
  console.log(`${one.name}.png ${png.length} bytes`);
}
