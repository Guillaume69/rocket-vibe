import type { Provider } from '../../lib/provider.ts';
import type { PresenceStatus } from '../../lib/presence.ts';
import { MmClient, MmError } from './client.ts';

export function mattermostActivity(client: MmClient, userId: string): NonNullable<Provider['ownActivity']> {
  const statusOf = (raw: unknown): PresenceStatus => {
    const value = raw as { user_id?: unknown; status?: unknown } | null;
    const status = value?.status === 'dnd' ? 'busy' : value?.status;
    if (value?.user_id !== userId || !['online', 'away', 'busy', 'offline'].includes(String(status)))
      throw new MmError(502, null, 'Unexpected activity response');
    return status as PresenceStatus;
  };
  return {
    read: async () => statusOf(await client.get('/users/me/status')),
    set: async (status) => statusOf(await client.put('/users/me/status', {
      body: { user_id: userId, status: status === 'busy' ? 'dnd' : status },
    })),
  };
}
