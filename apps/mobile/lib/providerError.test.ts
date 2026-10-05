import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeProviderError } from './providerError.ts';
import { TwoFactorError, RestError } from './rest.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';

test('provider diagnostics preserve native request identity and retry delay', () => {
  const error = describeProviderError(new NativeError(429,'ticket_limit',30,'request-id'),true);
  assert.equal(error.requestId,'request-id');
  assert.equal(error.retryAfter,30);
  assert.equal(error.rejectsSession,false);
});
test('only an authenticated understood rejection can describe a lost session', () => {
  assert.equal(describeProviderError(new NativeError(401,'session_rejected'),false).rejectsSession,false);
  assert.equal(describeProviderError(new NativeError(401,'session_rejected'),true).rejectsSession,true);
  assert.equal(describeProviderError(new RestError('proxy',401),true).rejectsSession,false);
  const challenge = describeProviderError(new TwoFactorError('totp',['totp'],false),true);
  assert.equal(challenge.twoFactorChallenge,true);
  assert.equal(challenge.rejectsSession,false);
  assert.equal(describeProviderError(new Error('network'),true).status,0);
});
