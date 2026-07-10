/**
 * Résolution des codes courts d'emoji.
 *
 * Rocket.Chat 8.5 pré-parse le markdown dans `msg.md` mais **laisse le code
 * court intact** : `:smile:` devient `{type:'EMOJI', shortCode:'smile'}`, sans
 * champ `unicode`. Le serveur ne connaît que le nom ; c'est au client de
 * savoir que `smile` s'écrit 😄. Sans cette table, l'écran affiche `:smile:`.
 *
 * Corollaire, et il n'est pas cosmétique : le parseur ne VALIDE rien. Un
 * `:pas_un_emoji:` isolé sort du serveur en `BIG_EMOJI` comme n'importe quel
 * vrai emoji. La table est donc aussi le seul juge de ce qui est un emoji, et
 * `null` veut dire « ce n'en est pas un » — pas « je ne sais pas l'afficher ».
 * Un emoji personnalisé du serveur (`emoji-custom`) tombe dans ce cas : il
 * reste `:nom:` littéral, ce qui se lit, plutôt qu'un glyphe manquant.
 *
 * Module pur, sans React : testable sous Node. La table elle-même est générée
 * par `scripts/generer-emojis.mjs` (voir sa doc pour la source et la licence).
 */

import { CODES_EMOJI } from './emojis.genere.ts';

let table: Record<string, string> | null = null;

/**
 * `null` si le code court n'est pas un emoji connu — jamais une chaîne vide,
 * qu'un appelant confondrait avec « emoji sans glyphe ».
 */
export function unicodeDeCodeCourt(code: string): string | null {
  table ??= JSON.parse(CODES_EMOJI) as Record<string, string>;
  // `typeof` et pas `in` : le `md` vient d'autrui, et `:constructor:` est un
  // code court parfaitement légal côté serveur. Il remonterait une fonction
  // du prototype d'`Object` jusque dans un `<Text>`.
  const points = table[code];
  if (typeof points !== 'string') return null;
  // La table stocke `1f9d1-1f3fb-200d-1f3a8`, pas 🧑🏻‍🎨 : voir le générateur —
  // un seul glyphe y ferait basculer la chaîne entière en UTF-16 côté Hermes.
  // Le générateur garantit la forme ; `lib/emojis.test.ts` la vérifie en bloc.
  return String.fromCodePoint(...points.split('-').map((p) => parseInt(p, 16)));
}
