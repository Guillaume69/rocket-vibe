/**
 * The app's active language: subscribable store + React hooks.
 *
 * Same pattern as `ui/identities`: a module-level store rather than a Provider.
 * Wrapping the stack for the language would REMOUNT the whole navigation tree
 * on every switch; here each component subscribes via `useSyncExternalStore`
 * and only re-renders on an actual language change. The PURE core (catalogue,
 * `translate`, Intl detection, types) lives in `ui/messages.ts`, testable under
 * Node; this module carries the ONLY platform piece: persistence.
 *
 * The preference is read SYNCHRONOUSLY at module load (`SecureStore.getItem`):
 * the first render already has the right language, no "French then English"
 * flash at startup. It is GLOBAL to the device (not per server, unlike
 * sessions): a single key.
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
 * `SecureStore.getItem` is SYNCHRONOUS (SDK 50+): the preference is read before
 * the first render. Any value other than `fr`/`en` (absent, corrupt storage)
 * falls back to "automatic"; an access failing at startup must never brick the
 * app, hence the `try`.
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
 * Changes the language. `'auto'` DELETES the key (back to the phone's
 * language), an explicit language writes it. The write is async and
 * best-effort: the UI switches at once, the disk follows.
 */
export function setLanguage(pref: LanguagePreference): void {
  preference = pref;
  activeLanguage = resolve(pref);
  if (pref === 'auto') void SecureStore.deleteItemAsync(KEY);
  // iOS: also read by the Notification Service Extension, on the lock screen.
  else void SecureStore.setItemAsync(KEY, pref, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The RESOLVED language ('fr' | 'en'). Re-renders the caller on every switch. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, () => activeLanguage);
}

/** The PREFERENCE ('fr' | 'en' | 'auto'), to tick the right option in the picker. */
export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/**
 * The translator bound to the current language. Stable while the language
 * does not change (`useCallback`): passed as a dependency of a
 * `useMemo`/`useEffect`, it only invalidates them on an actual switch.
 */
export function useT(): TranslateFn {
  const language = useLanguage();
  return useCallback((key, params) => translate(language, key, params), [language]);
}

/**
 * Message times in the current language. Memoised on the language: the
 * underlying `Intl.DateTimeFormat` is only rebuilt on an actual switch, not on
 * every message row rendered.
 */
export function useTimeFormatter(): (ms: number) => string {
  const language = useLanguage();
  return useMemo(() => timeFormatter(language), [language]);
}

/** The day separator label (« Aujourd'hui », « Hier », the date). */
export function useDayFormatter(): (ms: number) => string {
  const language = useLanguage();
  return useMemo(() => dayFormatter(language), [language]);
}

/**
 * Translates with the ACTIVE language, OUTSIDE any component (native handlers,
 * module-level callbacks with no access to hooks). Reflects the user's current
 * choice: prefer it to `translate(deviceLanguage(), …)`, which would ignore a
 * language explicitly selected in settings.
 */
export function translateCurrent(key: TranslationKey, params?: TranslationParams): string {
  return translate(activeLanguage, key, params);
}
