/**
 * The icon font is generated: these tests fail when an SVG changed without
 * `npm run icons:generate`, and pin what the generator refuses to draw.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { build, glyphPath, paths } from '../scripts/generate-icons.mjs';
import { ICON_GLYPHS } from './icons.generated.ts';

const ROOT = join(import.meta.dirname, '..');
const ICONS = join(ROOT, 'assets', 'icons');

function sources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(ICONS)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => [f.slice(0, -4), readFileSync(join(ICONS, f), 'utf8')]),
  );
}

test('the committed font and table are those of the committed SVGs', () => {
  const { ttf, glyphs } = build(sources());
  assert.deepEqual(
    glyphs.map((g: { name: string; code: number }) => [g.name, String.fromCodePoint(g.code)]),
    Object.entries(ICON_GLYPHS),
  );
  assert.ok(ttf.equals(readFileSync(join(ROOT, 'assets', 'fonts', 'RocketVibeIcons.ttf'))));
});

test('refuses what it cannot draw', () => {
  const svg = (body: string) => `<svg viewBox="0 0 16 16">${body}</svg>`;
  assert.throws(() => paths('a', svg('<circle r="2"/>')), /circle/);
  assert.throws(() => paths('a', svg('<g transform="scale(2)"><path d="M0 0h1v1z"/></g>')), /transform/);
  assert.throws(() => paths('a', svg('<path d="M0 0h1v1z" stroke="#000"/>')), /stroke/);
  assert.throws(() => paths('a', '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>'), /16 px grid/);
  assert.throws(() => paths('a', svg('')), /no path/);
});

test('flips into font units and drops a bare trailing move', () => {
  // (0,0) at the top left of the 16 px grid is the ascent, (16,16) 1/8 em below the baseline.
  assert.equal(glyphPath(['M0 0H16V16Z m 0 0']), 'M0 896H1024V-128Z');
});
