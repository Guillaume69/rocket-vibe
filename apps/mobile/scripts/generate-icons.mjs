#!/usr/bin/env node
/**
 * Generates the interface's icon font, `assets/fonts/RocketVibeIcons.ttf`, and
 * its name table `ui/icons.generated.ts`, from the SVGs of `assets/icons/`.
 *
 *   npm run icons:generate
 *
 * The icons are the desktop's: GNOME's Adwaita symbolic icons (16 px grid,
 * monochrome), taken from adwaita-icon-theme 50.0 (`Adwaita/symbolic/<category>/
 * <name>-symbolic.svg`), the theme the GTK app draws with. A font rather than
 * images: drawn by `<Text>` (no dependency), tinted by `color`, sharp at any
 * size, aligned with the text around it. See `ui/icon.tsx`.
 *
 * Only filled `<path>` elements are read: anything else (shapes, transforms,
 * strokes, clips) throws rather than drawing a wrong glyph. Partial opacity is
 * dropped (`non-starred` is a translucent star in GTK, a solid one here), and
 * TrueType fills by the non-zero rule, so an `evenodd` icon must not rely on
 * it for its holes.
 *
 * Deterministic output (names sorted, code points from U+E000 in that order,
 * a fixed timestamp): rerunning the script must leave `git diff` empty.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const svg2ttf = require('svg2ttf');
const svgpath = require('svgpath');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ICONS = join(ROOT, 'assets', 'icons');
const FONT = join(ROOT, 'assets', 'fonts', 'RocketVibeIcons.ttf');
const TABLE = join(ROOT, 'ui', 'icons.generated.ts');

const FAMILY = 'RocketVibeIcons';
const GRID = 16;
const EM = 1024;
const SCALE = EM / GRID;
// The icon sits like a letter with a descender: 1/8 em under the baseline.
const DESCENT = EM / 8;
const ASCENT = EM - DESCENT;
const FIRST = 0xe000;

/** The `d` of every path of an icon, refusing what this script cannot draw. */
export function paths(name, svg) {
  const unsupported = svg.match(
    /<(rect|circle|ellipse|line|polyline|polygon|use|image|text|clipPath|mask)\b|\btransform=|\bstroke="(?!none)|\bclip-path=|\bmask=/,
  );
  if (unsupported) throw new Error(`${name}.svg: unsupported \`${unsupported[0]}\``);
  // A view box, else the size; `insert-link` is 16 x 15.98.
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const box = root.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const [w, h] = box
    ? [Number(box[1]), Number(box[2])]
    : [parseFloat(root.match(/\swidth="([\d.]+)/)?.[1] ?? ''), parseFloat(root.match(/\sheight="([\d.]+)/)?.[1] ?? '')];
  if (!(Math.abs(w - GRID) < 0.1 && Math.abs(h - GRID) < 0.1)) {
    throw new Error(`${name}.svg: not on the 16 px grid`);
  }
  const ds = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length === 0) throw new Error(`${name}.svg: no path`);
  return ds;
}

/** The end points' bounding box of one subpath of absolute segments. */
function extent(segments) {
  let [x, y] = [0, 0];
  const xs = [];
  const ys = [];
  for (const s of segments) {
    if (s[0] === 'H') x = s[1];
    else if (s[0] === 'V') y = s[1];
    else if (s[0] !== 'Z') [x, y] = s.slice(-2);
    xs.push(x);
    ys.push(y);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * The subpaths an SVG renderer shows. GTK clips an icon to its 16 px box:
 * Adwaita's `package-x-generic` keeps a second drawing 40 px down, which a
 * glyph would keep, and its bounding box would then stretch the font's
 * metrics and every line holding an icon. A subpath wholly outside is
 * dropped; one only partly outside is refused, not clipped.
 */
export function visible(name, segments) {
  const subpaths = [];
  for (const s of segments) {
    if (s[0] === 'M' || subpaths.length === 0) subpaths.push([]);
    subpaths.at(-1).push(s);
  }
  return subpaths
    .filter((sub) => {
      // Inkscape ends many paths with a bare `m 0 0`: a one-point contour
      // that the font would keep as a stray mark.
      if (sub.length === 1) return false;
      const e = extent(sub);
      if (e.maxX < 0 || e.minX > GRID || e.maxY < 0 || e.minY > GRID) return false;
      if (e.minX < -0.5 || e.maxX > GRID + 0.5 || e.minY < -0.5 || e.maxY > GRID + 0.5) {
        throw new Error(`${name}.svg: a shape crosses the 16 px box`);
      }
      return true;
    })
    .flat();
}

/** SVG (y down, 16 px) to font units (y up, baseline at 0). */
export function glyphPath(ds, name = 'icon') {
  return ds
    .map((d) => {
      const path = svgpath(d).abs().unarc().unshort();
      path.segments = visible(name, path.segments);
      return path.scale(SCALE, -SCALE).translate(0, ASCENT).round(1).toString();
    })
    .join('');
}

export function build(icons) {
  const names = Object.keys(icons).sort();
  const glyphs = names.map((name, i) => ({ name, code: FIRST + i, d: glyphPath(paths(name, icons[name]), name) }));
  const font =
    `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="${FAMILY}" horiz-adv-x="${EM}">` +
    `<font-face font-family="${FAMILY}" units-per-em="${EM}" ascent="${ASCENT}" descent="-${DESCENT}"/>` +
    `<missing-glyph horiz-adv-x="0"/>` +
    glyphs
      .map((g) => `<glyph glyph-name="${g.name}" unicode="&#x${g.code.toString(16)};" horiz-adv-x="${EM}" d="${g.d}"/>`)
      .join('') +
    `</font></defs></svg>`;
  const ttf = svg2ttf(font, {
    // The licence travels with the font, the only copy inside the APK.
    copyright:
      'Icons: GNOME Project (https://www.gnome.org), adwaita-icon-theme 50.0, under CC BY-SA 3.0 United States ' +
      '(http://creativecommons.org/licenses/by-sa/3.0/us/) or LGPL-3.0; this font is a derivative under the same ' +
      'terms. Send arrow: RocketVibe.',
    description: 'RocketVibe interface icons',
    url: 'http://creativecommons.org/licenses/by-sa/3.0/us/',
    version: '1.0',
    ts: 0,
  });
  return { ttf: Buffer.from(ttf.buffer), glyphs };
}

function table(glyphs) {
  const lines = glyphs.map((g) => `  '${g.name}': '\\u${g.code.toString(16).toUpperCase()}',`);
  return `// ⚠️ GENERATED by \`npm run icons:generate\`: do not edit by hand.
//
// ${glyphs.length} interface icons of the \`${FAMILY}\` font (assets/fonts), each
// name to its private-use character. Adwaita symbolic icons, the desktop's.
// See \`scripts/generate-icons.mjs\` and \`ui/icon.tsx\`.

export const ICON_GLYPHS = {
${lines.join('\n')}
} as const;

export type IconName = keyof typeof ICON_GLYPHS;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const icons = Object.fromEntries(
    readdirSync(ICONS)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => [f.slice(0, -4), readFileSync(join(ICONS, f), 'utf8')]),
  );
  const { ttf, glyphs } = build(icons);
  writeFileSync(FONT, ttf);
  writeFileSync(TABLE, table(glyphs));
  console.log(`${glyphs.length} icons -> ${FONT} (${ttf.length} bytes), ${TABLE}`);
}
