import { getShareExtensionKey } from 'expo-share-intent';

/**
 * iOS : l'extension de partage rouvre l'app par `rocketvibe://dataUrl=<clé>`.
 * Ce n'est pas une route ; laissé à expo-router, il afficherait « page
 * introuvable ». On reste où l'on est : `GardePartage` (app/_layout.tsx) voit
 * le partage et ouvre l'écran dédié. Tout autre lien passe tel quel, dont le
 * deep link des notifications Android.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  try {
    if (path?.includes(`dataUrl=${getShareExtensionKey()}`)) return null;
    return path;
  } catch {
    return path;
  }
}
