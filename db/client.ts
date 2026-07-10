/**
 * Ouverture de la base locale. **Une base par serveur et par compte** — voir
 * `nomFichier.ts` pour le pourquoi.
 *
 * `enableChangeListener: true` est obligatoire : sans lui, `useLiveQuery` ne
 * recevrait jamais les notifications d'écriture et l'UI resterait figée alors
 * que le WebSocket alimente la base.
 *
 * Le mode WAL évite qu'une lecture de l'UI bloque une écriture du moteur de
 * synchro, et inversement.
 */

import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import { nomFichier } from './nomFichier.ts';
import * as schema from './schema.ts';

export type BaseLocale = ReturnType<typeof drizzle<typeof schema>>;

export { nomFichier };

const ouvertes = new Map<string, { brute: SQLiteDatabase; base: BaseLocale }>();

/** Idempotent : deux écrans qui demandent la même base partagent la connexion. */
export function ouvrirBase(
  baseUrl: string,
  utilisateurId?: string,
): { brute: SQLiteDatabase; base: BaseLocale } {
  const nom = nomFichier(baseUrl, utilisateurId);
  const existante = ouvertes.get(nom);
  if (existante) return existante;

  const brute = openDatabaseSync(nom, { enableChangeListener: true });
  // WAL : une lecture de l'UI ne bloque pas une écriture du moteur de synchro.
  // Pas de `PRAGMA foreign_keys` : le schéma n'en déclare aucune, volontairement.
  // Un message peut arriver par le WebSocket avant le salon qui le contient.
  brute.execSync('PRAGMA journal_mode = WAL;');

  const paire = { brute, base: drizzle(brute, { schema }) };
  ouvertes.set(nom, paire);
  return paire;
}

export function fermerBase(baseUrl: string, utilisateurId?: string): void {
  const nom = nomFichier(baseUrl, utilisateurId);
  const paire = ouvertes.get(nom);
  if (!paire) return;
  paire.brute.closeSync();
  ouvertes.delete(nom);
}
