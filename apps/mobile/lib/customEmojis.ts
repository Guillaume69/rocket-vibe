/**
 * Emojis personnalisés du serveur.
 *
 * `msg.md` livre `:party_parrot:` comme n'importe quel code court —
 * `{type:'EMOJI', shortCode:'party_parrot'}`, sans `unicode` — indistinguable
 * d'un emoji inconnu. Ce qui le distingue vit ici : la liste `emoji-custom.list`
 * du serveur, qui donne le nom de FICHIER (`party_parrot.png`) à afficher.
 * Le rendu tranche donc dans cet ordre : caractère Unicode (`lib/emojis.ts`),
 * sinon image custom (ici), sinon `:nom:` littéral.
 *
 * L'URL est PUBLIQUE : `/emoji-custom/:nom.:ext` répond sans `rc_token`, à la
 * différence des fichiers et avatars (`FileUpload_ProtectFiles` ne couvre pas
 * les emojis — vérifié sur 8.5). On la construit depuis le nom CANONIQUE :
 * `/emoji-custom/:alias.:ext` renvoie un SVG de secours, pas l'image.
 *
 * État de MODULE, résolu synchrone comme `unicodeDeCodeCourt` : le rendu
 * markdown n'est pas réactif, et une lecture async par emoji serait absurde.
 * La base SQLite étant par (serveur, compte), on n'indexe qu'un serveur à la
 * fois — celui de la session active, posé par `definirEmojisCustom`.
 */

export type EmojiCustom = { nom: string; extension: string; aliases: string[] };

/** Persistance des emojis custom. Implémentée sur SQLite (`db/store.ts`). */
export interface DepotEmojis {
  /** Remplace TOUTE la table par `entrees` (la liste serveur est complète). */
  remplacer(entrees: EmojiCustom[]): Promise<void>;
  lister(): Promise<EmojiCustom[]>;
}

type Cible = { nom: string; extension: string };

/** Un `unknown` (réseau ou JSON de la base) vers une liste d'alias propre. */
export function filtrerAliases(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Déplie noms et alias en un index `code court → fichier`. **Deux passes** :
 * tous les noms canoniques d'abord, les alias ensuite — ainsi un nom ne peut
 * JAMAIS être masqué par l'alias homonyme d'une autre entrée, quel que soit
 * l'ordre du serveur. Entre deux entrées valides, la première posée gagne.
 */
export function indexer(entrees: EmojiCustom[]): Map<string, Cible> {
  const index = new Map<string, Cible>();
  const valides = entrees.filter(
    (e) => typeof e?.nom === 'string' && typeof e.extension === 'string',
  );
  for (const e of valides) {
    if (!index.has(e.nom)) index.set(e.nom, { nom: e.nom, extension: e.extension });
  }
  for (const e of valides) {
    for (const alias of e.aliases ?? []) {
      if (typeof alias === 'string' && !index.has(alias)) {
        index.set(alias, { nom: e.nom, extension: e.extension });
      }
    }
  }
  return index;
}

let index = new Map<string, Cible>();
let baseActive: string | null = null;
// Cache de `codesEmojiCustom()` : rebâti seulement quand l'index change, pas à
// chaque frappe du composer. Invalidé partout où `index` est réassigné.
let codesCache: readonly string[] | null = null;

// L'index doit être OBSERVABLE par l'UI : le navigateur d'emojis ne se démonte
// jamais (`usePanneauEmoji` le monte une fois pour toutes), donc « lu au
// montage » signifie « figé pour la session » — à la première installation,
// `synchroniserEmojisCustom` court APRÈS le montage et l'onglet ⭐ n'existait
// pas. `surChangementEmojisCustom` + `codesEmojiCustom` forment le contrat
// `useSyncExternalStore` : le cache gelé ci-dessus EST l'instantané stable.
const abonnes = new Set<() => void>();

function notifierChangement(): void {
  for (const abonne of [...abonnes]) abonne();
}

/** S'abonner aux réassignations de l'index — rend le désabonnement. */
export function surChangementEmojisCustom(abonne: () => void): () => void {
  abonnes.add(abonne);
  return () => {
    abonnes.delete(abonne);
  };
}

/** Pose l'index du serveur actif. Appelé au démarrage puis après un fetch. */
export function definirEmojisCustom(baseUrl: string, entrees: EmojiCustom[]): void {
  baseActive = baseUrl.replace(/\/+$/, '');
  index = indexer(entrees);
  codesCache = null;
  notifierChangement();
}

/** À la déconnexion : un index survivant servirait les emojis de l'ancien serveur. */
export function viderEmojisCustom(): void {
  index = new Map();
  baseActive = null;
  codesCache = null;
  notifierChangement();
}

/**
 * URL absolue de l'image d'un code court custom, ou `null` si ce n'en est pas
 * un. `Map.get` ne remonte pas le prototype d'`Object` — pas de garde à ajouter.
 */
export function urlEmojiCustom(shortCode: string): string | null {
  const cible = index.get(shortCode);
  if (cible === undefined || baseActive === null) return null;
  return `${baseActive}/emoji-custom/${encodeURIComponent(cible.nom)}.${encodeURIComponent(cible.extension)}`;
}

/**
 * Tous les codes courts custom connus (noms canoniques ET alias), pour
 * l'autocomplétion. GELÉ et mis en cache : le même tableau est rendu tant que
 * l'index ne change pas (invalidé par `definir`/`viderEmojisCustom`), donc pas
 * de recopie ni de risque de mutation à chaque frappe.
 */
export function codesEmojiCustom(): readonly string[] {
  return (codesCache ??= Object.freeze([...index.keys()]));
}

/** Un `unknown` du réseau vers une entrée propre, ou `null` si inexploitable. */
export function normaliserEntree(brut: unknown): EmojiCustom | null {
  if (typeof brut !== 'object' || brut === null) return null;
  const o = brut as { name?: unknown; extension?: unknown; aliases?: unknown };
  if (typeof o.name !== 'string' || typeof o.extension !== 'string') return null;
  return { nom: o.name, extension: o.extension, aliases: filtrerAliases(o.aliases) };
}

type ReponseListe = { emojis?: { update?: unknown[] } };

/** Le sous-ensemble de `ClientRest` dont on a besoin — pour tester sans lui. */
type ClientLecture = {
  baseUrl: string;
  get: <T>(
    chemin: string,
    options?: { params?: Record<string, string | number | boolean | undefined> },
  ) => Promise<T>;
};

/**
 * Charge `emoji-custom.list` (complet), remplace la table et pose l'index.
 * Complet et non incrémental : la liste est petite, un delta et ses `remove[]`
 * seraient une complexité sans gain. Silencieux à l'échec — hors ligne, la
 * table SQLite déjà chargée fait foi, et les customs dégradent en `:nom:`.
 *
 * SANS paramètre : `emoji-custom.list` n'accepte QUE `updatedSince` — un `count`
 * répond « must NOT have additional properties » (vérifié sur 8.5). Et on ne
 * remplace la table QUE sur une liste réellement reçue : un appel raté, dont
 * l'`update` serait `undefined`, ne doit pas VIDER le cache offline.
 *
 * `estAbandonne` : l'index est un état de MODULE, partagé par toutes les
 * sessions. Un fetch lancé par le serveur A qui résout APRÈS une déconnexion
 * ou un changement de serveur ne doit pas réarmer l'index (il ferait fuiter
 * les images de A dans l'UI de B, et une requête non authentifiée vers A).
 */
export async function synchroniserEmojisCustom(
  client: ClientLecture,
  depot: DepotEmojis,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const reponse = await client.get<ReponseListe>('emoji-custom.list');
  const brut = reponse.emojis?.update;
  if (!Array.isArray(brut)) return;
  const entrees = brut.map(normaliserEntree).filter((e): e is EmojiCustom => e !== null);
  await depot.remplacer(entrees);
  if (estAbandonne()) return;
  definirEmojisCustom(client.baseUrl, entrees);
}

/** Au démarrage : la table SQLite (offline) vers l'index mémoire. */
export async function restaurerEmojisCustom(
  baseUrl: string,
  depot: DepotEmojis,
  estAbandonne: () => boolean = () => false,
): Promise<void> {
  const entrees = await depot.lister();
  if (estAbandonne()) return;
  definirEmojisCustom(baseUrl, entrees);
}
