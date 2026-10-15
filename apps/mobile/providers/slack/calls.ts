/**
 * Slack's huddles as the app's calls. There is no API to start or join one:
 * a call's id is its page in Slack's web app (the room's page opening its huddle), and the call screen opens it in the browser, signed in there.
 */

import type { NativeCalls } from '../../lib/call.ts';
import { huddlePage, huddleUrl } from './translator.ts';

export function slackCalls(team: string): NativeCalls {
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
  };
}
