/**
 * La garde de MainActivity du plugin de partage, sur l'extrait du gabarit
 * Expo SDK 57 qu'elle vise.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { neutraliser } = require('./with-incoming-share.js');

const GABARIT = `package com.rocketvibe.app

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
  const sortie = neutraliser(GABARIT);
  assert.match(sortie, /^import android\.content\.Intent$/m);
  const garde = sortie.indexOf('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY');
  assert.ok(garde > 0 && garde < sortie.indexOf('super.onCreate'));
  assert.match(sortie, /savedInstanceState != null/);
});

test('idempotent', () => {
  const une = neutraliser(GABARIT);
  assert.equal(neutraliser(une), une);
});

test('refuse un gabarit qu’il ne reconnaît pas', () => {
  assert.throws(() => neutraliser('class MainActivity {}'), /onCreate introuvable/);
});
