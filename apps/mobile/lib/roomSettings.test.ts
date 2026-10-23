import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoomInformation } from './provider.ts';
import { nameEmptied, roomSettingsChanges, roomSettingsDraft } from './roomSettings.ts';

const info: RoomInformation = {
  id: 'r1',
  name: 'general',
  type: 'c',
  topic: 'Topic',
  description: null,
  announcement: null,
  members: 3,
  readOnly: false,
};

test('the draft starts from rooms.info, absent texts as empty fields', () => {
  assert.deepEqual(roomSettingsDraft(info), { name: 'general', topic: 'Topic', description: '', announcement: '', readOnly: false });
});

test('only the changed keys go out, read-only included when switched', () => {
  const current = roomSettingsDraft(info);
  assert.equal(roomSettingsChanges(current, { ...current }), null);
  assert.deepEqual(roomSettingsChanges(current, { ...current, readOnly: true }), { readOnly: true });
  assert.deepEqual(roomSettingsChanges(current, { ...current, topic: '', announcement: 'Hi' }), { topic: '', announcement: 'Hi' });
  // Switched on then back off: nothing to send.
  assert.equal(roomSettingsChanges(current, { ...current, readOnly: false }), null);
  const readOnlyRoom = roomSettingsDraft({ ...info, readOnly: true });
  assert.deepEqual(roomSettingsChanges(readOnlyRoom, { ...readOnlyRoom, readOnly: false, description: 'D' }), { description: 'D', readOnly: false });
});

test('a name is trimmed, sent when it changed and never emptied', () => {
  const current = roomSettingsDraft(info);
  assert.equal(roomSettingsChanges(current, { ...current, name: ' general ' }), null);
  assert.deepEqual(roomSettingsChanges(current, { ...current, name: ' Ops team ' }), { name: 'Ops team' });
  assert.equal(roomSettingsChanges(current, { ...current, name: '  ' }), null);
  assert.deepEqual([nameEmptied({ ...current, name: ' ' }), nameEmptied(current)], [true, false]);
});
