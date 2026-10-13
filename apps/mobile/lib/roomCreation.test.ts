import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { creationRefusal } from './roomCreation.ts';

describe('creationRefusal', () => {
  it('a missing right is "forbidden", whatever the server says it with', () => {
    assert.equal(creationRefusal({ code: 'permission_denied' }), 'newRoom.forbidden');
    assert.equal(creationRefusal({ status: 403 }), 'newRoom.forbidden');
    assert.equal(creationRefusal({ status: 400, errorType: 'error-not-allowed' }), 'newRoom.forbidden');
  });

  it('a taken or malformed name says so', () => {
    assert.equal(creationRefusal({ status: 400, errorType: 'error-duplicate-channel-name' }), 'newRoom.nameTaken');
    assert.equal(creationRefusal({ status: 400, errorType: 'error-invalid-room-name' }), 'newRoom.nameInvalid');
  });

  it('anything else is a plain failure', () => {
    assert.equal(creationRefusal({ status: 500, errorType: 'error-unknown' }), 'newRoom.failed');
    assert.equal(creationRefusal(new Error('network down')), 'newRoom.failed');
    assert.equal(creationRefusal(null), 'newRoom.failed');
    assert.equal(creationRefusal(undefined), 'newRoom.failed');
    assert.equal(creationRefusal('permission_denied'), 'newRoom.failed');
    assert.equal(creationRefusal(403), 'newRoom.failed');
  });
});
