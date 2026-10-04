#!/usr/bin/env node
/**
 * Génère `lib/emojis.generated.ts` : la table « code court → caractère Unicode »
 * que Rocket.Chat n'envoie PAS.
 *
 *   npm run emojis:generate
 *
 * Le serveur pré-parse `:smile:` en `{type:'EMOJI', shortCode:'smile'}` et
 * s'arrête là — vérifié sur 8.5, aucun champ `unicode` n'accompagne un code
 * court. La résolution appartient au client, et il lui faut donc la table.
 *
 * Source : `emoji-toolkit` (JoyPixels), d'où Rocket.Chat tire ses shortnames —
 * même source, mêmes noms, `:+1:` compris. Sa LICENSE.md sépare nettement les
 * deux régimes : **artwork** sous licence JoyPixels restrictive, **« Javascript,
 * JSON, PHP, CSS, HTML files » sous MIT**. On ne prend que le JSON et on
 * n'embarque aucune image : les emojis sont rendus par la police du système
 * (Noto Color Emoji sur Android). D'où la dépendance de DÉVELOPPEMENT seule,
 * et cette table figée dans le dépôt — le runtime n'a rien à installer.
 *
 * Sortie déterministe (clés triées, un seul gagnant par collision) : relancer
 * le script sur la même version doit laisser `git diff` vide.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, 'lib', 'emojis.generated.ts');

const emojis = require('emoji-toolkit/emoji.json');
const version = require('emoji-toolkit/package.json').version;

// `order` croissant, pour que le vainqueur d'une collision de code court ne
// dépende pas de l'ordre des clés du JSON.
const entries = Object.entries(emojis).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));

const table = new Map();
let collisions = 0;
for (const [hex, e] of entries) {
  // `display: 0` = retiré du sélecteur amont (doublons, codes obsolètes).
  if (e.display !== 1) continue;
  // `fully_qualified` et pas la clé : `:heart:` est `2764-fe0f`, avec le
  // sélecteur de variante. Sans lui, la police rend un ❤ noir de texte.
  const points = e.code_points?.fully_qualified || e.code_points?.base || hex;
  for (const name of [e.shortname, ...(e.shortname_alternates ?? [])]) {
    const code = name.slice(1, -1); // `:smile:` → `smile`
    if (table.has(code)) {
      if (table.get(code) !== points) collisions++;
      continue;
    }
    table.set(code, points);
  }
}

const sorted = [...table].sort((a, b) => (a[0] < b[0] ? -1 : 1));

// Échappe tout hors ASCII imprimable en `\uXXXX`, au niveau du JSON pour que
// `JSON.parse` le restitue. Ce n'est pas de la coquetterie :
//
//   Hermes range chaque chaîne du bytecode en ASCII (1 o/car) ou en UTF-16
//   (2 o/car), et un SEUL caractère non-ASCII bascule la chaîne ENTIÈRE.
//
// La table en glyphes bruts pesait 399 054 o dans le bundle release (mesuré :
// +399 968 o) — les 6222 clés ASCII payaient le double à cause des emojis. En
// hexadécimal et sans le moindre octet haut (`piñata` compris), elle tombe à
// 275 018 o. Le décodage coûte 236 ns par emoji rendu.
const toAscii = (obj) =>
  JSON.stringify(obj).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

const json = toAscii(Object.fromEntries(sorted));
if (!/^[\x00-\x7f]*$/.test(json)) throw new Error('la table doit rester ASCII pure');

// Index des CATÉGORIES pour le navigateur d'emojis : codes de base (hors
// variantes de teinte `_tone`, hors `shortname_alternates`), groupés par
// catégorie et ordonnés par `order` — l'ordre canonique JoyPixels, celui que
// l'œil attend (grinning, smiley, smile…). Les catégories techniques `regional`
// (tuiles-lettres) et `modifier` (pastilles de teinte) sont écartées : on ne
// pioche pas ça dans un navigateur. On ne garde qu'un code réellement présent
// dans `table` — même juge que le rendu, aucune suggestion non résoluble.
const CATEGORIES = [
  'people',
  'nature',
  'food',
  'activity',
  'travel',
  'objects',
  'symbols',
  'flags',
];
const byCategory = Object.fromEntries(CATEGORIES.map((cat) => [cat, []]));
const orderedBase = Object.values(emojis)
  .filter(
    (e) => e.display === 1 && CATEGORIES.includes(e.category) && !/_tone\d/.test(e.shortname),
  )
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
for (const e of orderedBase) {
  const code = e.shortname.slice(1, -1);
  if (table.has(code)) byCategory[e.category].push(code);
}
const jsonCategories = toAscii(byCategory);
if (!/^[\x00-\x7f]*$/.test(jsonCategories)) throw new Error('les catégories doivent rester ASCII pures');
const baseCount = Object.values(byCategory).reduce((n, l) => n + l.length, 0);

const file = `// ⚠️ GÉNÉRÉ par \`npm run emojis:generate\` — ne pas éditer à la main.
//
// ${table.size} codes courts Rocket.Chat → points de code, extraits de
// emoji-toolkit ${version} (JoyPixels), dont le JSON est sous licence MIT.
// Aucune image n'est embarquée : la police du système rend les caractères.
// Voir \`scripts/generate-emojis.mjs\` et \`lib/emojis.ts\`.
//
// Une CHAÎNE, pas un objet littéral : \`JSON.parse\` à la première demande
// coûte moins que ${table.size} propriétés matérialisées au chargement du module,
// pour un écran qui n'affiche parfois aucun emoji.
//
// Des POINTS DE CODE en hexadécimal, pas des glyphes : la chaîne reste ASCII,
// que Hermes range sur un octet par caractère au lieu de deux (−124 Ko).

export const EMOJI_CODES = ${JSON.stringify(json)};

// Catégories du navigateur d'emojis : ${baseCount} codes de BASE (hors variantes de
// teinte), groupés et ordonnés comme JoyPixels. Une chaîne \`JSON.parse\`-ée à la
// demande, tout ASCII, pour la même raison que ci-dessus. On ne stocke que des
// NOMS (pas les glyphes) : le rendu les résout via \`unicodeDeCodeCourt\`.
export const EMOJIS_BY_CATEGORY = ${JSON.stringify(jsonCategories)};
`;

writeFileSync(OUTPUT, file);
const bytes = new TextEncoder().encode(file).length;
console.log(
  `lib/emojis.generated.ts : ${table.size} codes courts + ${baseCount} de base classés, ${bytes} octets ` +
    `(emoji-toolkit ${version}, ${collisions} collision(s) divergente(s) écartée(s))`,
);
