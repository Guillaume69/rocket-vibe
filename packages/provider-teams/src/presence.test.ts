import assert from 'node:assert/strict';
import { test } from 'node:test';

import { availabilityStatus, presenceEvents, presenceRows, statusAvailability } from './presence.ts';
import { presenceSubscription } from './client.ts';
import { presencePush, presenceUri } from './trouter.ts';

test('Teams availability maps onto the app presence states', () => {
  assert.equal(availabilityStatus('Available'), 'online');
  assert.equal(availabilityStatus('AvailableIdle'), 'online');
  assert.equal(availabilityStatus('Away'), 'away');
  assert.equal(availabilityStatus('BeRightBack'), 'away');
  assert.equal(availabilityStatus('Busy'), 'busy');
  assert.equal(availabilityStatus('DoNotDisturb'), 'busy');
  assert.equal(availabilityStatus('InAMeeting'), 'busy');
  assert.equal(availabilityStatus('Offline'), 'offline');
  assert.equal(availabilityStatus('PresenceUnknown'), 'offline');
  assert.equal(availabilityStatus(null), 'offline');
});

test('setting a presence chooses a Teams availability', () => {
  assert.equal(statusAvailability('online'), 'Available');
  assert.equal(statusAvailability('away'), 'Away');
  assert.equal(statusAvailability('busy'), 'DoNotDisturb');
  assert.equal(statusAvailability('offline'), 'Offline');
});

test('pushed presence changes become the app\'s live presence events', () => {
  const body = JSON.stringify({ presence: [{ mri: '8:orgid:a', presence: { availability: 'Available' } }, { mri: '8:orgid:b', presence: { availability: 'BusyIdle' } }] });
  const pushed = presencePush({ id: 1, url: '/v4/f/abc/unifiedPresenceService', body });
  assert.ok(pushed);
  const events = presenceEvents(presenceRows(pushed));
  assert.deepEqual(events.map((e) => e.args[0]), [['8:orgid:a', '', 1, ''], ['8:orgid:b', '', 3, '']]);
  assert.equal(events[0].eventKey, 'user-status');
  assert.equal(presencePush({ id: 1, url: '/v4/f/abc/messaging', body }), null);
});

test('presence is watched where Teams pushes it', () => {
  assert.equal(presenceUri('https://pub-ent-euno-13-f.trouter.teams.microsoft.com:3443/v4/f/KcH2/'), 'https://pub-ent-euno-13-f.trouter.teams.microsoft.com:3443/v4/f/KcH2/unifiedPresenceService');
  const request = presenceSubscription('https://t/v4/f/k/unifiedPresenceService', ['8:orgid:a']);
  assert.deepEqual(request.subscriptionsToAdd, [{ mri: '8:orgid:a', source: 'ups' }]);
  assert.equal(request.shouldPurgePreviousSubscriptions, false);
});
