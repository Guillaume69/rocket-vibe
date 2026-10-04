import { getShareExtensionKey } from 'expo-share-intent';

/**
 * iOS: the share extension reopens the app with `rocketvibe://dataUrl=<key>`.
 * That is not a route; left to expo-router, it would show "page not found".
 * We stay where we are: `ShareGuard` (app/_layout.tsx) sees the share and
 * opens the dedicated screen. Any other link passes through unchanged,
 * including the Android notification deep link.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  try {
    if (path?.includes(`dataUrl=${getShareExtensionKey()}`)) return null;
    return path;
  } catch {
    return path;
  }
}
