import { getShareExtensionKey } from 'expo-share-intent';
import {systemRoomPath} from '../lib/roomLinks.ts';

import { withEnglishRoomPath } from '../lib/roomLink.ts';
import { isKchatRedirect } from '../providers/mattermost/kchatOAuth.ts';

/**
 * iOS: the share extension reopens the app with `rocketvibe://dataUrl=<key>`.
 * That is not a route; left to expo-router, it would show "page not found".
 * We stay where we are: `ShareGuard` (app/_layout.tsx) sees the share and
 * opens the dedicated screen. Any other link passes through, an old
 * `salon/` room link rewritten to `room/`.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  try {
    if (path?.includes(`dataUrl=${getShareExtensionKey()}`)) return null;
    // The kChat sign-in redirect is read by the login screen's `Linking` listener, not routed.
    if (isKchatRedirect(path)) return null;
    return systemRoomPath(path === null ? null : withEnglishRoomPath(path));
  } catch {
    return path === null ? null : withEnglishRoomPath(path);
  }
}
