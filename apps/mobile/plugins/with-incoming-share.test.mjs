/**
 * The share plugin's MainActivity guard, on the Expo SDK 57 template excerpt
 * it targets.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { neutralize } = require('./with-incoming-share.js');

const TEMPLATE = `package com.rocketvibe.app

import android.os.Build
import android.os.Bundle

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }
}
`;

test('the guard precedes super.onCreate and imports Intent', () => {
  const outbox = neutralize(TEMPLATE);
  assert.match(outbox, /^import android\.content\.Intent$/m);
  const watchdog = outbox.indexOf('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY');
  assert.ok(watchdog > 0 && watchdog < outbox.indexOf('super.onCreate'));
  assert.match(outbox, /savedInstanceState != null/);
});

test('idempotent', () => {
  const one = neutralize(TEMPLATE);
  assert.equal(neutralize(one), one);
});

test('rejects a template it does not recognize', () => {
  assert.throws(() => neutralize('class MainActivity {}'), /onCreate not found/);
});
