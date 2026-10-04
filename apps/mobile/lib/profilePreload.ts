/**
 * Préchargement de la fiche utilisateur AVANT d'ouvrir la sheet `/profile`.
 *
 * La sheet est une `formSheet` `sheetAllowedDetents: 'fitToContents'` : elle se
 * mesure au PREMIER rendu. Si le contenu (nom, rôles, bio, fuseau, bouton
 * « Appeler ») arrive ensuite en async, la hauteur bondit — le « saut » que
 * l'utilisateur voyait. On casse ça en récupérant `users.info` ET en figeant la
 * sonde d'appel AVANT de naviguer : au montage, l'écran lit cette fiche depuis
 * le cache et démarre déjà complet, à sa hauteur définitive.
 *
 * Le cache n'est PAS un cache de fraîcheur : c'est un tampon de passage entre
 * l'appel pré-navigation et la première frame de l'écran. Chaque ouverture
 * refait l'appel et réécrit l'entrée, donc la fiche affichée est toujours celle
 * qu'on vient de chercher.
 *
 * `client` et navigation en singletons (posés depuis `ui/` — `SessionProvider`
 * pour le client, le layout racine pour le navigateur) et non passés en
 * paramètre : une mention `@user` dans un corps de message est rendue par de
 * simples fonctions (`ui/markdown.tsx`), sans rien sous la main. C'est aussi ce
 * qui garde ce module CHARGEABLE SOUS NODE : ni `expo-router` ni i18n ici — la
 * navigation est injectée, l'erreur voyage en clé à traduire à l'affichage.
 */

import type { TranslationKey } from '../ui/messages.ts'; // import type seul : consigné, comme lib/systemMessages.ts
import { probeCallAvailable } from './call.ts';
import type { ClientRest } from './rest.ts';

/** Une des deux formes acceptées par `users.info` (jamais les deux à la fois). */
export type ProfileParams = { username?: string; uid?: string };

/**
 * Pourquoi `user` manque : une clé du catalogue — traduite à l'AFFICHAGE, ce
 * module est du lib/ pur — ou le message d'une `ErreurRest`, déjà en langue.
 */
export type ProfileError = { key: TranslationKey } | { message: string };

/** Brut `users.info` mis en cache : `user` absent ⇒ échec décrit par `erreur`. */
export type RawProfile = { user: Record<string, unknown> | undefined; error: ProfileError | null };

/**
 * Plafond d'attente avant d'ouvrir malgré tout. Sur réseau normal, `users.info`
 * répond bien en-dessous et la sheet s'ouvre déjà complète ; au-delà (réseau qui
 * traîne), on ouvre quand même — l'écran retombe sur son chargement async, avec
 * son squelette. Mieux vaut un tap qui répond qu'un tap qui semble mort.
 */
const CAP_MS = 2000;

/**
 * Anti-clignotement de l'indicateur, en deux temps :
 *
 * - `SEUIL_INDICATEUR_MS` : délai avant de l'AFFICHER. Sous ce délai — le cas
 *   normal — rien ne s'affiche, la sheet s'ouvre, tap perçu instantané. Réglé
 *   assez haut pour que la latence prod ordinaire passe DESSOUS et ne déclenche
 *   rien.
 * - `DUREE_MIN_VISIBLE_MS` : une fois affiché, il y RESTE au moins ce temps,
 *   quitte à retarder un peu l'ouverture. Sans ça, un chargement qui finit juste
 *   après le seuil ferait apparaître la pastille pour la masquer aussitôt — le
 *   flash. Un loader qui clignote fait plus « cassé » que « lent ».
 */
const INDICATOR_THRESHOLD_MS = 450;
const MIN_VISIBLE_MS = 400;

let activeClient: ClientRest | null = null;

/** Posé par `SessionProvider` à chaque changement de session. */
export function setProfileClient(client: ClientRest | null): void {
  activeClient = client;
}

let activeBrowser: ((p: ProfileParams) => void) | null = null;

/**
 * Posé par le layout racine (`app/_layout.tsx`) : c'est LUI qui sait pousser
 * `/profile` — ce module, du lib/ pur, ne connaît pas expo-router. Même modèle
 * que `definirClientProfil`. Sans navigateur posé (jamais le cas une fois
 * l'app montée), l'ouverture est un no-op silencieux.
 */
export function setProfileNavigator(nav: ((p: ProfileParams) => void) | null): void {
  activeBrowser = nav;
}

// --- Indicateur d'ouverture (différé) --------------------------------------
// Store minimal, hors React (ce module est du `lib/`) : l'UI s'y abonne via
// `ui/openingIndicator`. `poserBusy` ne notifie que sur changement réel.
type BusyListener = (active: boolean) => void;
const listeners = new Set<BusyListener>();
let busy = false;

function setBusy(v: boolean): void {
  if (busy === v) return;
  busy = v;
  for (const e of listeners) e(v);
}

/** Abonne un écouteur à l'état « ouverture en cours » ; renvoie le désabonnement. */
export function subscribeProfileOpening(cb: BusyListener): () => void {
  listeners.add(cb);
  cb(busy);
  return () => {
    listeners.delete(cb);
  };
}

const cache = new Map<string, RawProfile>();

function key(p: ProfileParams): string {
  return typeof p.username === 'string' && p.username !== ''
    ? `u:${p.username}`
    : `i:${p.uid ?? ''}`;
}

/** Fiche préchargée pour ces params, ou `undefined` si l'écran doit charger lui-même. */
export function readPreloadedProfile(p: ProfileParams): RawProfile | undefined {
  return cache.get(key(p));
}

/**
 * Fin de session / changement de serveur.
 *
 * Le cache retient des fiches `users.info` BRUTES — rôles, bio, fuseau, champs
 * personnalisés — sous une clé qui ne porte ni serveur ni compte. Le chemin
 * nominal ne peut pas les servir à un autre compte (`prechargerPuisOuvrir`
 * réécrit l'entrée avant de pousser l'écran), mais les laisser en mémoire pour
 * la vie du process est une résidence de données personnelles que rien ne
 * justifie — et une course étroite suffit à les afficher.
 */
export function forgetProfileCards(): void {
  cache.clear();
  currentKey = null;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** La CIBLE dont l'ouverture est en vol — voir la garde de `ouvrirFicheProfil`. */
let currentKey: string | null = null;

/**
 * Précharge la fiche puis ouvre `/profile`. À utiliser à la place d'un
 * `router.push('/profile')` direct, partout où l'on ouvre une fiche.
 *
 * Réentrance gardée : la fonction attend jusqu'à `PLAFOND_MS` avant de pousser
 * l'écran, et l'indicateur d'attente est monté en `pointerEvents="none"` — rien
 * n'arrêtait donc un second tap. On récoltait deux `push`, donc deux fiches
 * empilées à refermer, et le `finally` de la première exécution éteignait
 * l'indicateur alors que la seconde volait encore (`poserBusy` est un booléen
 * global, pas un compteur). Garde d'ÉTAT, comme partout ailleurs dans le dépôt
 * (app/message-actions.tsx, app/search.tsx, app/profile.tsx) : aucun délai
 * ajouté.
 *
 * La garde porte sur la CIBLE, pas sur « une ouverture quelconque » : un verrou
 * global aurait avalé, jusqu'à 2,4 s durant et sans le moindre retour visuel
 * (l'indicateur n'apparaît qu'après `SEUIL_INDICATEUR_MS`), un tap sur un AUTRE
 * profil — que l'utilisateur aurait dû retaper. Deux cibles différentes gardent
 * donc le comportement d'avant.
 */
export async function openProfileCard(p: ProfileParams): Promise<void> {
  const k = key(p);
  if (currentKey === k) return;
  currentKey = k;
  try {
    await preloadThenOpen(p);
  } finally {
    // Une ouverture plus récente a pris la main : ne pas effacer SA clé.
    if (currentKey === k) currentKey = null;
  }
}

async function preloadThenOpen(p: ProfileParams): Promise<void> {
  const client = activeClient;
  const k = key(p);

  // Sans client (cas improbable : avant que la session soit posée) — on ouvre
  // directement, l'écran fera l'appel. On purge toute entrée d'une ouverture
  // précédente pour ne pas servir du périmé.
  if (client === null) {
    cache.delete(k);
    activeBrowser?.(p);
    return;
  }

  const params: ProfileParams =
    typeof p.username === 'string' && p.username !== ''
      ? { username: p.username }
      : { uid: p.uid ?? '' };
  const rest = params.username !== undefined ? { username: params.username } : { userId: params.uid };

  const rawFetch = client
    .get<{ user?: Record<string, unknown> }>('users.info', { params: rest })
    .then<RawProfile>((r) => ({
      user: r.user,
      error: r.user ? null : { key: 'profile.profileUnreadable' },
    }))
    .catch<RawProfile>((e: unknown) => ({
      user: undefined,
      error: e instanceof Error ? { message: e.message } : { key: 'profile.profileNotFound' },
    }));

  // Indicateur différé : ne s'affiche QUE si l'attente dépasse le seuil, et
  // reste alors visible un minimum (anti-flash — voir les constantes).
  let shownAt: number | null = null;
  const timer = setTimeout(() => {
    setBusy(true);
    shownAt = Date.now();
  }, INDICATOR_THRESHOLD_MS);
  // On attend AUSSI la sonde d'appel (mémoïsée par serveur) : c'est elle qui
  // décide de la présence du bouton « Appeler », donc de la hauteur finale.
  let raw: RawProfile | null;
  try {
    raw = await Promise.race<RawProfile | null>([
      Promise.all([rawFetch, probeCallAvailable(client)]).then(([b]) => b),
      delay(CAP_MS).then(() => null),
    ]);
  } finally {
    clearTimeout(timer);
    if (shownAt !== null) {
      // Pastille affichée : la maintenir jusqu'à son minimum avant de masquer
      // et d'ouvrir — sinon flash. On ouvre donc pile quand elle disparaît.
      const remainingMs = MIN_VISIBLE_MS - (Date.now() - shownAt);
      if (remainingMs > 0) await delay(remainingMs);
    }
    setBusy(false);
  }

  if (raw !== null) {
    cache.set(k, raw);
  } else {
    // Plafond dépassé : ouvrir sans servir une entrée périmée d'avant — l'écran
    // relira un miss et fera son propre chargement async.
    cache.delete(k);
  }
  activeBrowser?.(p);
}
