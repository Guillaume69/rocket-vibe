/**
 * The room settings form (`ui/roomSettingsEditor.tsx`): what the sheet shows,
 * and the change Save sends. Only what differs from the room as its server
 * read it goes out, so an untouched text or switch is never rewritten. A name
 * is trimmed and never emptied: Rocket.Chat ignores an empty one silently and
 * Mattermost stores it (both probed on the benches, 2026-10-23).
 */

import type { RoomInformation, RoomSettingsChange, RoomTexts } from './provider.ts';

export type RoomSettingsDraft = RoomTexts & { name: string; readOnly: boolean };

const TEXTS: readonly (keyof RoomTexts)[] = ['topic', 'description', 'announcement'];

/** The form's starting values: an absent text is an empty field. */
export function roomSettingsDraft(info: RoomInformation): RoomSettingsDraft {
  return {
    name: info.name,
    topic: info.topic ?? '',
    description: info.description ?? '',
    announcement: info.announcement ?? '',
    readOnly: info.readOnly,
  };
}

/** The changed keys only; `null` when nothing changed (Save stays disabled). */
export function roomSettingsChanges(current: RoomSettingsDraft, draft: RoomSettingsDraft): RoomSettingsChange | null {
  const change: RoomSettingsChange = {};
  const name = draft.name.trim();
  if (name !== current.name.trim() && name !== '') change.name = name;
  for (const key of TEXTS) if (draft[key] !== current[key]) change[key] = draft[key];
  if (draft.readOnly !== current.readOnly) change.readOnly = draft.readOnly;
  return Object.keys(change).length === 0 ? null : change;
}

/** Whether the draft empties the name, which Save refuses. */
export function nameEmptied(draft: RoomSettingsDraft): boolean {
  return draft.name.trim() === '';
}
