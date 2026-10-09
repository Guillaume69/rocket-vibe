/**
 * The conversation list settings kChat's web app shows, read and written as
 * the account's preferences: `display_settings/name_format` (unless the
 * server's `LockTeammateNameDisplay`) and `sidebar_settings/limit_visible_dms_gms`.
 * The server's `preferences_changed` that follows a write moves the list.
 */

import type { SidebarSettings } from '../../lib/provider.ts';
import type { MmClient } from './client.ts';
import { nameFormatOf } from './directory.ts';
import { DEFAULT_DM_LIMIT } from './sidebar.ts';

type Doc = Record<string, unknown>;

export function mattermostSidebarSettings(client: MmClient, myId: string) {
  return {
    async read(): Promise<SidebarSettings> {
      const [config, prefs] = await Promise.all([
        client.get<Doc>('/config/client', { query: { format: 'old' } }).catch(() => ({}) as Doc),
        client.get<unknown>('/users/me/preferences'),
      ]);
      const list = Array.isArray(prefs) ? (prefs as Doc[]) : [];
      const value = (category: string, name: string) => list.find((p) => p.category === category && p.name === name)?.value;
      const locked = config.LockTeammateNameDisplay === 'true';
      const server = nameFormatOf(config.TeammateNameDisplay) ?? 'full_name';
      const limit = Number(value('sidebar_settings', 'limit_visible_dms_gms'));
      return {
        nameFormat: locked ? server : (nameFormatOf(value('display_settings', 'name_format')) ?? server),
        nameLocked: locked,
        dmLimit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DM_LIMIT,
      };
    },
    async write(change: Partial<Pick<SidebarSettings, 'nameFormat' | 'dmLimit'>>): Promise<void> {
      const body: Doc[] = [];
      if (change.nameFormat !== undefined) body.push({ user_id: myId, category: 'display_settings', name: 'name_format', value: change.nameFormat });
      if (change.dmLimit !== undefined) body.push({ user_id: myId, category: 'sidebar_settings', name: 'limit_visible_dms_gms', value: String(change.dmLimit) });
      if (body.length > 0) await client.put('/users/me/preferences', { body });
    },
  };
}
