import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { registerPackageList } = require('./with-expo-package-list.js');

test('generated package-list registration survives repeated CNG application', () => {
  const template = "apply plugin: 'expo-root-project'\n";
  const once = registerPackageList(template);
  assert.equal(registerPackageList(once), once);
  assert.ok(once.startsWith(template));
  assert.match(once, /task\.dependsOn\(packageList\)/);
  assert.match(once, /task\.source\(packageList\.flatMap \{ it\.outputFile \}\)/);
});

test('changed Expo template fails prebuild instead of silently omitting native modules', () => {
  assert.throws(() => registerPackageList("apply plugin: 'com.android.application'"), /Expo root Gradle plugin not found/);
});
