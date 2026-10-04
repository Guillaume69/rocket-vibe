import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashCodeJava, roomNotificationId } from './notificationId.ts';

/**
 * Les valeurs attendues ne sont pas dérivées de l'implémentation : elles
 * sortent d'un `java.lang.String.hashCode` réellement exécuté (Temurin 17,
 * 31/07/2026). C'est le seul juge qui compte — le nombre doit être celui que le
 * Kotlin du service push a posé en id de notification, sans quoi
 * `dismissNotificationAsync` retirerait une notification qui n'existe pas et
 * laisserait la vraie dans la barre d'état.
 */
describe('hashCodeJava', () => {
  it('rend 0 sur la chaîne vide', () => {
    assert.equal(hashCodeJava(''), 0);
  });

  it('rend le code du caractère sur une chaîne d’un caractère', () => {
    assert.equal(hashCodeJava('a'), 97);
  });

  it('apparie Java sur un nom de salon', () => {
    assert.equal(hashCodeJava('GENERAL'), 637834440);
    assert.equal(hashCodeJava('laprivitude'), 38673287);
  });

  it('apparie Java sur un rid Rocket.Chat (24 hexa)', () => {
    assert.equal(hashCodeJava('64c7f9dbd7e0f4b1a2c3d4e5'), -2042430465);
    assert.equal(hashCodeJava('Ldk8sPq2Xr9TnMvB'), 359843299);
  });

  it('déborde en 32 bits SIGNÉS comme Java, sans passer en flottant', () => {
    // 34 caractères : le produit dépasse 2^53 depuis longtemps. Sans `imul`,
    // JavaScript perdrait les bits de poids faible et rendrait un autre nombre.
    assert.equal(hashCodeJava('a'.repeat(34)), -1149727200);
  });

  it('compte en unités UTF-16, pas en points de code', () => {
    assert.equal(hashCodeJava('é'), 233);
    // Une paire de substitution vaut DEUX itérations côté Java aussi.
    assert.equal(hashCodeJava('🚀'), 1773027);
  });
});

describe('identifiantNotifSalon', () => {
  it('produit la forme que `parseNotificationIdentifier` d’expo sait lire', () => {
    assert.equal(
      roomNotificationId('GENERAL'),
      'expo-notifications://foreign_notifications?id=637834440',
    );
  });

  it('garde le signe : un id négatif reste un entier Java valide', () => {
    // `Integer.parseInt("-2042430465")` accepte le moins ; tronquer le signe
    // viserait une autre notification.
    assert.equal(
      roomNotificationId('64c7f9dbd7e0f4b1a2c3d4e5'),
      'expo-notifications://foreign_notifications?id=-2042430465',
    );
  });
});
