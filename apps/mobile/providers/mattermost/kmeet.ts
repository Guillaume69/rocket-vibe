/**
 * kChat's calls: kMeet meetings the kChat server opens, as Infomaniak's own
 * app does. `POST /conferences {channel_id}` starts one in a room (and posts
 * its `custom_call`), `POST /conferences/<id>/answer` joins one; both answer
 * the meeting's `url` and a `jwt` for it. The call view opens `url?jwt=`, on
 * kMeet's origin only.
 */

import type { NativeCalls } from '../../lib/call.ts';
import type { MmClient } from './client.ts';
import { isKmeetUrl } from './translator.ts';

type Conference = { id?: unknown; url?: unknown; jwt?: unknown };

export function kmeetCalls(client: MmClient): NativeCalls {
  const meeting = (c: Conference): string => {
    if (typeof c.url !== 'string' || !isKmeetUrl(c.url)) throw new Error('call_url_invalid');
    return typeof c.jwt === 'string' && c.jwt !== '' ? `${c.url}?jwt=${encodeURIComponent(c.jwt)}` : c.url;
  };
  return {
    available: async () => true,
    memo: () => true,
    start: async (room) => {
      const c = await client.post<Conference>('/conferences', { body: { channel_id: room } });
      if (typeof c.id !== 'string') throw new Error('call_id_missing');
      return c.id;
    },
    join: async (id) => meeting(await client.post<Conference>(`/conferences/${encodeURIComponent(id)}/answer`)),
  };
}
