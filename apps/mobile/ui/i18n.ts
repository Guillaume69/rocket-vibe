/**
 * Langue active de l'application : store abonnable + hooks React.
 *
 * Même patron que `ui/identities` : un store module-level plutôt qu'un Provider.
 * Envelopper la pile pour la langue REMONTERAIT tout l'arbre de navigation à
 * chaque bascule ; ici chaque composant s'abonne via `useSyncExternalStore` et
 * ne se re-rend qu'au vrai changement de langue. Le noyau PUR (catalogue,
 * `traduire`, détection Intl, types) vit dans `ui/messages.ts`, testable sous
 * Node ; ce module-ci porte le SEUL morceau plateforme : la persistance.
 *
 * La préférence est lue de FAÇON SYNCHRONE au chargement du module
 * (`SecureStore.getItem`) : le premier rendu a déjà la bonne langue, aucun flash
 * « français puis anglais » au démarrage. Elle est GLOBALE à l'appareil (pas par
 * serveur, contrairement aux sessions) : une seule clé.
 */

import * as SecureStore from 'expo-secure-store';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  type TranslationKey,
  type Language,
  type TranslationParams,
  type LanguagePreference,
  type TranslateFn,
  timeFormatter,
  dayFormatter,
  deviceLanguage,
  translate,
} from './messages.ts';

const KEY = 'langue-preferee';

/**
 * `SecureStore.getItem` est SYNCHRONE (SDK 50+) : on lit la préférence avant le
 * premier rendu. Toute valeur autre que `fr`/`en` (absence, stockage corrompu)
 * retombe sur « automatique » ; un accès qui échoue au démarrage ne doit jamais
 * briquer l'app, d'où le `try`.
 */
function readPreference(): LanguagePreference {
  try {
    const raw = SecureStore.getItem(KEY);
    return raw === 'fr' || raw === 'en' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

function resolve(pref: LanguagePreference): Language {
  return pref === 'auto' ? deviceLanguage() : pref;
}

let preference: LanguagePreference = readPreference();
let activeLanguage: Language = resolve(preference);
const listeners = new Set<() => void>();

/**
 * Change la langue. `'auto'` EFFACE la clé (on retombe sur la langue du
 * téléphone), une langue explicite l'écrit. L'écriture est asynchrone et
 * best-effort : l'UI bascule tout de suite, le disque suit.
 */
export function setLanguage(pref: LanguagePreference): void {
  preference = pref;
  activeLanguage = resolve(pref);
  if (pref === 'auto') void SecureStore.deleteItemAsync(KEY);
  // iOS : lue aussi par la Notification Service Extension, écran verrouillé.
  else void SecureStore.setItemAsync(KEY, pref, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** La langue RÉSOLUE ('fr' | 'en'). Re-rend l'appelant à chaque bascule. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, () => activeLanguage);
}

/** La PRÉFÉRENCE ('fr' | 'en' | 'auto'), pour cocher la bonne option du sélecteur. */
export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/**
 * Le traducteur lié à la langue courante. Stable tant que la langue ne change
 * pas (`useCallback`) : passé en dépendance d'un `useMemo`/`useEffect`, il ne
 * les invalide qu'à une vraie bascule.
 */
export function useT(): TranslateFn {
  const language = useLanguage();
  return useCallback((key, params) => translate(language, key, params), [language]);
}

/**
 * L'heure des messages dans la langue courante. Mémoïsé sur la langue : le
 * `Intl.DateTimeFormat` sous-jacent n'est reconstruit qu'à une vraie bascule,
 * pas à chaque ligne de message rendue.
 */
export function useTimeFormatter(): (ms: number) => string {
  const language = useLanguage();
  return useMemo(() => timeFormatter(language), [language]);
}

/** Le libellé des séparateurs de jour (« Aujourd'hui », « Hier », la date). */
export function useDayFormatter(): (ms: number) => string {
  const language = useLanguage();
  return useMemo(() => dayFormatter(language), [language]);
}

/**
 * Traduit avec la langue ACTIVE, HORS de tout composant (handlers natifs,
 * callbacks module-level qui n'ont pas accès aux hooks). Reflète le choix
 * courant de l'utilisateur — à préférer à `traduire(langueAppareil(), …)`, qui
 * ignorerait une langue explicitement sélectionnée dans les paramètres.
 */
export function translateCurrent(key: TranslationKey, params?: TranslationParams): string {
  return translate(activeLanguage, key, params);
}
