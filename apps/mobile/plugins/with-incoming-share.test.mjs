/**
 * La garde de MainActivity du plugin de partage, sur l'extrait du gabarit
 * Expo SDK 57 qu'elle vise.
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

test('la garde précède super.onCreate et importe Intent', () => {
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

test('refuse un gabarit qu’il ne reconnaît pas', () => {
  assert.throws(() => neutralize('class MainActivity {}'), /onCreate not found/);
});
