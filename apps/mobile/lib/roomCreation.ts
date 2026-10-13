/**
 * The sentence for a refused room creation (`app/new-room.tsx`), as a key
 * translated at display time, so this stays loadable under Node. RocketVibe
 * names its refusal `permission_denied`; Rocket.Chat answers 403 to
 * `channels.create` and `error-not-allowed` to `groups.create` without the
 * right (read in the 8.5 bundle), and refuses a taken or malformed name with
 * its own types (probed on 8.5.1).
 */

import type { TranslationKey } from '../ui/messages.ts'; // type-only import, like lib/profilePreload.ts

export function creationRefusal(e: unknown): TranslationKey {
  const refusal = typeof e === 'object' && e !== null ? (e as { code?: unknown; status?: unknown; errorType?: unknown }) : null;
  if (refusal?.code === 'permission_denied' || refusal?.status === 403 || refusal?.errorType === 'error-not-allowed') {
    return 'newRoom.forbidden';
  }
  if (refusal?.errorType === 'error-duplicate-channel-name') return 'newRoom.nameTaken';
  if (refusal?.errorType === 'error-invalid-room-name') return 'newRoom.nameInvalid';
  return 'newRoom.failed';
}
