/**
 * Application des migrations, **par base** — chaque couple (serveur, compte) a
 * la sienne.
 *
 * `migrerBase` mémoïse par nom de fichier et par promesse : deux appelants du
 * même tick partagent la même exécution au lieu de faire courir deux
 * `migrate()` sur la même base. Le corps vit dans une fonction async : même
 * une levée **synchrone** (`openDatabaseSync` sur un fichier corrompu) devient
 * un rejet, que l'appelant attrape au lieu de s'écrouler.
 */

import { migrate } from 'drizzle-orm/expo-sqlite/migrator';

import { ouvrirBase } from './client.ts';
// Généré par `npm run db:generate`. Résolu grâce à `babel-plugin-inline-import`
// et à l'extension `sql` ajoutée aux `sourceExts` de Metro.
import migrations from './migrations/migrations.js';
import { nomFichier } from './fileName.ts';

/**
 * Le serveur proposé par défaut sur l'écran de connexion, et celui dont la
 * base sert à l'écran debug hors session. L'étape 5.3 (multi-serveurs) fera
 * du « serveur actif » la seule référence.
 *
 * En release, le serveur CIBLE du projet ; le Docker local n'a de sens qu'en
 * dev. Le garde `typeof` : ce module est aussi chargé sous Node (tests), où
 * `__DEV__` n'existe pas.
 */
export const SERVEUR_PAR_DEFAUT =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://localhost:3000' : 'https://chat.barrut.me';

const enCours = new Map<string, Promise<void>>();

export function migrerBase(baseUrl: string, utilisateurId?: string): Promise<void> {
  const nom = nomFichier(baseUrl, utilisateurId);
  const existante = enCours.get(nom);
  if (existante !== undefined) return existante;

  const promesse = (async () => {
    await migrate(ouvrirBase(baseUrl, utilisateurId).base, migrations);
  })();
  enCours.set(nom, promesse);
  // Un échec ne doit pas rester mémoïsé : le prochain appel retente.
  promesse.catch(() => enCours.delete(nom));
  return promesse;
}
