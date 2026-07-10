#!/usr/bin/env node
/**
 * Génère `lib/emojis.genere.ts` : la table « code court → caractère Unicode »
 * que Rocket.Chat n'envoie PAS.
 *
 *   npm run emojis:generer
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
const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const SORTIE = join(RACINE, 'lib', 'emojis.genere.ts');

const emojis = require('emoji-toolkit/emoji.json');
const version = require('emoji-toolkit/package.json').version;

// `order` croissant, pour que le vainqueur d'une collision de code court ne
// dépende pas de l'ordre des clés du JSON.
const entrees = Object.entries(emojis).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));

const table = new Map();
let collisions = 0;
for (const [hex, e] of entrees) {
  // `display: 0` = retiré du sélecteur amont (doublons, codes obsolètes).
  if (e.display !== 1) continue;
  // `fully_qualified` et pas la clé : `:heart:` est `2764-fe0f`, avec le
  // sélecteur de variante. Sans lui, la police rend un ❤ noir de texte.
  const points = e.code_points?.fully_qualified || e.code_points?.base || hex;
  for (const nom of [e.shortname, ...(e.shortname_alternates ?? [])]) {
    const code = nom.slice(1, -1); // `:smile:` → `smile`
    if (table.has(code)) {
      if (table.get(code) !== points) collisions++;
      continue;
    }
    table.set(code, points);
  }
}

const trie = [...table].sort((a, b) => (a[0] < b[0] ? -1 : 1));
// Tout hors ASCII imprimable est échappé `\uXXXX` — au niveau du JSON, donc
// `JSON.parse` le restituera. Ce n'est pas de la coquetterie :
//
//   Hermes range chaque chaîne du bytecode en ASCII (1 o/car) ou en UTF-16
//   (2 o/car), et un SEUL caractère non-ASCII bascule la chaîne ENTIÈRE.
//
// La table en glyphes bruts pesait donc 399 054 o dans le bundle release
// (mesuré : +399 968 o) — les 6222 clés ASCII payaient le double à cause des
// emojis. En hexadécimal et sans le moindre octet haut (`piñata` compris),
// elle tombe à 275 018 o. Le décodage coûte 236 ns par emoji rendu.
const json = JSON.stringify(Object.fromEntries(trie)).replace(
  /[^\x20-\x7e]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
);
if (!/^[\x00-\x7f]*$/.test(json)) throw new Error('la table doit rester ASCII pure');

const fichier = `// ⚠️ GÉNÉRÉ par \`npm run emojis:generer\` — ne pas éditer à la main.
//
// ${table.size} codes courts Rocket.Chat → points de code, extraits de
// emoji-toolkit ${version} (JoyPixels), dont le JSON est sous licence MIT.
// Aucune image n'est embarquée : la police du système rend les caractères.
// Voir \`scripts/generer-emojis.mjs\` et \`lib/emojis.ts\`.
//
// Une CHAÎNE, pas un objet littéral : \`JSON.parse\` à la première demande
// coûte moins que ${table.size} propriétés matérialisées au chargement du module,
// pour un écran qui n'affiche parfois aucun emoji.
//
// Des POINTS DE CODE en hexadécimal, pas des glyphes : la chaîne reste ASCII,
// que Hermes range sur un octet par caractère au lieu de deux (−124 Ko).

export const CODES_EMOJI = ${JSON.stringify(json)};
`;

writeFileSync(SORTIE, fichier);
const octets = new TextEncoder().encode(fichier).length;
console.log(
  `lib/emojis.genere.ts : ${table.size} codes courts, ${octets} octets ` +
    `(emoji-toolkit ${version}, ${collisions} collision(s) divergente(s) écartée(s))`,
);
