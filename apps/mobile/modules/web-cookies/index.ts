import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Bridge to the Kotlin module (`android/…/WebCookiesModule.kt`), autolinked by
 * Expo from `modules/`. Android only: `null` on iOS and in a dev client built
 * before the module existed. Importable ONLY in the app: under Node,
 * expo-modules-core does not load.
 */

type NativeWebCookies = {
  /** The `name=value; …` cookies a request to `url` would carry, HttpOnly included. */
  get(url: string): string;
  /** The system web view's own user agent, or null before the app's context exists. */
  userAgent(): string | null;
  /** Empties the web views' cookie store. */
  clear(): Promise<void>;
};

export const WebCookies = requireOptionalNativeModule<NativeWebCookies>('WebCookies');
