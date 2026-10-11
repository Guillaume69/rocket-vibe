/**
 * The Rocket.Chat room settings form (`ui/roomSettingsEditor.tsx`): what the
 * sheet shows, and the change Save sends. Only what differs from the room as
 * `rooms.info` read it goes out, so an untouched text or switch is never
 * rewritten (`rooms.saveRoomSettings` then rebroadcasts nothing for it).
 */

import type { RoomInformation, RoomSettingsChange, RoomTexts } from './provider.ts';

export type RoomSettingsDraft = RoomTexts & { readOnly: boolean };

const TEXTS: readonly (keyof RoomTexts)[] = ['topic', 'description', 'announcement'];

/** The form's starting values: an absent text is an empty field. */
export function roomSettingsDraft(info: RoomInformation): RoomSettingsDraft {
  return {
    topic: info.topic ?? '',
    description: info.description ?? '',
    announcement: info.announcement ?? '',
    readOnly: info.readOnly,
  };
}

/** The changed keys only; `null` when nothing changed (Save stays disabled). */
export function roomSettingsChanges(current: RoomSettingsDraft, draft: RoomSettingsDraft): RoomSettingsChange | null {
  const change: RoomSettingsChange = {};
  for (const key of TEXTS) if (draft[key] !== current[key]) change[key] = draft[key];
  if (draft.readOnly !== current.readOnly) change.readOnly = draft.readOnly;
  return Object.keys(change).length === 0 ? null : change;
}
