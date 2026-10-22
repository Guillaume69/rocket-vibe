import assert from 'node:assert/strict';
import { test } from 'node:test';

import { availabilityStatus, statusAvailability } from './presence.ts';

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
