/**
 * My own presence on Slack, which knows only active and away: busy and
 * offline are set as away, and `auto` lets Slack call me active while a
 * client of mine is connected.
 */

import type { Provider } from '../../lib/provider.ts';
import type { PresenceStatus } from '../../lib/presence.ts';
import { SlackError, type SlackClient } from './client.ts';

export function slackPresence(raw: unknown): PresenceStatus {
  if (raw === 'active') return 'online';
  if (raw === 'away') return 'away';
  throw new SlackError('invalid_response');
}

export function slackActivity(client: SlackClient, myId: string): NonNullable<Provider['ownActivity']> {
  return {
    read: async () => slackPresence((await client.call('users.getPresence', { user: myId })).presence),
    set: async (status) => {
      const online = status === 'online';
      await client.call('users.setPresence', { presence: online ? 'auto' : 'away' });
      return online ? 'online' : 'away';
    },
  };
}
