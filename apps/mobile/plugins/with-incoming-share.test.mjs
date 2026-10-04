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
  const output = neutralize(TEMPLATE);
  assert.match(output, /^import android\.content\.Intent$/m);
  const guard = output.indexOf('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY');
  assert.ok(guard > 0 && guard < output.indexOf('super.onCreate'));
  assert.match(output, /savedInstanceState != null/);
});

test('idempotent', () => {
  const one = neutralize(TEMPLATE);
  assert.equal(neutralize(one), one);
});

test('rejects a template it does not recognize', () => {
  assert.throws(() => neutralize('class MainActivity {}'), /onCreate not found/);
});
