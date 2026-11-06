/**
 * Slack's huddles as the app's calls. A call's id is its page in Slack's web
 * app (the room's page opening its huddle), which the browser opens signed in
 * there when the voice engine cannot carry it: `rooms.join` starts or joins the
 * room's huddle and hands out Amazon Chime credentials for the native call.
 */

import type { ChimeCredentials, NativeCalls } from '@rocket-vibe/provider-api/calls';
import { huddleChannel, huddleMedia, huddlePage, huddlePerson, huddleUrl } from './translator.ts';

type HuddleBackend = {
  call: (method: 'rooms.join', args: Record<string, string>) => Promise<Record<string, unknown>>;
  ensure: (users: string[]) => Promise<void>;
  displayName: (id: string) => string | null;
};

export function slackCalls(team: string, backend?: HuddleBackend): NativeCalls {
  return {
    available: async () => true,
    memo: () => true,
    start: async (room) => {
      const url = huddleUrl(team, room);
      if (url === null) throw new Error('call_url_invalid');
      return url;
    },
    join: async (id) => {
      const page = huddlePage(id);
      if (page === null) throw new Error('call_url_invalid');
      return page;
    },
    ...(backend === undefined ? {} : {
      chime: async (id: string): Promise<ChimeCredentials> => {
        const channel = huddleChannel(id);
        if (channel === null) throw new Error('call_url_invalid');
        const media = huddleMedia(await backend.call('rooms.join', { channel_id: channel, multidevice: 'false' }));
        if (media === null) throw new Error('call_join_failed');
        return media;
      },
      personName: async (identity: string) => {
        const user = huddlePerson(identity);
        await backend.ensure([user]);
        return backend.displayName(user);
      },
    }),
  };
}
