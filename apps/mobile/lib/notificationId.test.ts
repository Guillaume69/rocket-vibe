import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashCodeJava, roomNotificationId } from './notificationId.ts';

/**
 * The expected values are not derived from the implementation: they come from
 * a `java.lang.String.hashCode` actually run (Temurin 17, 2026-07-31). That is
 * the only judge that counts: the number must be the one the push service's
 * Kotlin used as notification id, otherwise `dismissNotificationAsync` would
 * remove a notification that does not exist and leave the real one in the
 * status bar.
 */
describe('hashCodeJava', () => {
  it('returns 0 on the empty string', () => {
    assert.equal(hashCodeJava(''), 0);
  });

  it('returns the character code on a one-character string', () => {
    assert.equal(hashCodeJava('a'), 97);
  });

  it('matches Java on a room name', () => {
    assert.equal(hashCodeJava('GENERAL'), 637834440);
    assert.equal(hashCodeJava('laprivitude'), 38673287);
  });

  it('matches Java on a Rocket.Chat rid (24 hex)', () => {
    assert.equal(hashCodeJava('64c7f9dbd7e0f4b1a2c3d4e5'), -2042430465);
    assert.equal(hashCodeJava('Ldk8sPq2Xr9TnMvB'), 359843299);
  });

  it('overflows in SIGNED 32 bits like Java, without going to floating point', () => {
    // 34 characters: the product went past 2^53 long ago. Without `imul`,
    // JavaScript would lose the low-order bits and return another number.
    assert.equal(hashCodeJava('a'.repeat(34)), -1149727200);
  });

  it('counts in UTF-16 units, not code points', () => {
    assert.equal(hashCodeJava('é'), 233);
    // A surrogate pair is TWO iterations in Java too.
    assert.equal(hashCodeJava('🚀'), 1773027);
  });
});

describe('roomNotificationId', () => {
  it('produces the form expo `parseNotificationIdentifier` can read', () => {
    assert.equal(
      roomNotificationId('GENERAL'),
      'expo-notifications://foreign_notifications?id=637834440',
    );
  });

  it('keeps the sign: a negative id is still a valid Java integer', () => {
    // `Integer.parseInt("-2042430465")` accepts the minus; dropping the sign
    // would target another notification.
    assert.equal(
      roomNotificationId('64c7f9dbd7e0f4b1a2c3d4e5'),
      'expo-notifications://foreign_notifications?id=-2042430465',
    );
  });
});
