/**
 * Ouverture de la base locale. **Une base par serveur et par compte** — voir
 * `nomFichier.ts` pour le pourquoi.
 *
 * `enableChangeListener: true` est obligatoire : sans lui, `useRequeteVive` ne
 * recevrait jamais les notifications d'écriture et l'UI resterait figée alors
 * que le WebSocket alimente la base.
 *
 * Le mode WAL évite qu'une lecture de l'UI bloque une écriture du moteur de
 * synchro, et inversement.
 */

import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import { creerFileEcritures, type FileEcritures } from './fileEcritures.ts';
import { nomFichier } from './nomFichier.ts';
import * as schema from './schema.ts';

export type BaseLocale = ReturnType<typeof drizzle<typeof schema>>;

export { nomFichier };

type Connexion = { brute: SQLiteDatabase; base: BaseLocale; fileEcritures: FileEcritures };

/**
 * Les connexions ouvertes vivent pour la durée du PROCESS : rien n'appelle
 * `fermerBase` sur le chemin nominal, et c'est délibéré (voir sa doc). Chaque
 * couple (serveur, compte) visité y laisse donc une entrée.
 */
const ouvertes = new Map<string, Connexion>();

/**
 * Idempotent : deux écrans qui demandent la même base partagent la connexion —
 * **et sa file d'écritures**, qui est l'invariant réellement important. La file
 * sérialise les transactions d'une connexion (db/fileEcritures.ts) ; deux files
 * sur une même connexion ne protègent de rien, et c'est ce qui arrivait quand
 * l'appelant la créait lui-même : `SynchroProvider` rejoue son effet sur un
 * simple renommage (objet `session` neuf pour le même compte), fabriquait une
 * seconde file, et les deux moteurs s'entrelaçaient sur un seul SQLite.
 */
export function ouvrirBase(baseUrl: string, utilisateurId?: string): Connexion {
  const nom = nomFichier(baseUrl, utilisateurId);
  const existante = ouvertes.get(nom);
  if (existante) return existante;

  const brute = openDatabaseSync(nom, { enableChangeListener: true });
  // WAL : une lecture de l'UI ne bloque pas une écriture du moteur de synchro.
  // Pas de `PRAGMA foreign_keys` : le schéma n'en déclare aucune, volontairement.
  // Un message peut arriver par le WebSocket avant le salon qui le contient.
  brute.execSync('PRAGMA journal_mode = WAL;');

  const connexion: Connexion = {
    brute,
    base: drizzle(brute, { schema }),
    fileEcritures: creerFileEcritures(),
  };
  ouvertes.set(nom, connexion);
  return connexion;
}

/**
 * **Ne PAS appeler dans un cleanup React.** La connexion est partagée et le
 * cleanup court pendant que des écritures de l'ancien moteur peuvent encore
 * être en vol — fermer sous elles est pire que de laisser la connexion ouverte.
 * Gardée pour les tests et un éventuel effacement de compte, où l'on sait que
 * plus rien n'écrit.
 */
export function fermerBase(baseUrl: string, utilisateurId?: string): void {
  const nom = nomFichier(baseUrl, utilisateurId);
  const paire = ouvertes.get(nom);
  if (!paire) return;
  paire.brute.closeSync();
  ouvertes.delete(nom);
}
