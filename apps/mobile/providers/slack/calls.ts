/**
 * Slack's huddles as the app's calls. There is no API to start or join one:
 * a call's id is its page in Slack's web app (the room's huddle page to start
 * one), and the call screen opens it in the browser, signed in there.
 */

import type { NativeCalls } from '../../lib/call.ts';
import { huddleUrl, slackWeb } from './translator.ts';

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
      if (!slackWeb(id)) throw new Error('call_url_invalid');
      return id;
    },
  };
}
