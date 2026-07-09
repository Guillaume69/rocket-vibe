/**
 * Application des migrations au démarrage.
 *
 * Tant que la base du serveur courant n'est pas choisie (écran de connexion),
 * on migre celle du serveur par défaut. Le multi-serveur de l'étape 5.3
 * remplacera cette constante par le serveur sélectionné.
 */

import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';

import { ouvrirBase } from './client.ts';
// Généré par `npm run db:generate`. Résolu grâce à `babel-plugin-inline-import`
// et à l'extension `sql` ajoutée aux `sourceExts` de Metro.
import migrations from './migrations/migrations.js';

/**
 * **Provisoire.** Tant que l'écran de connexion n'existe pas, on migre la base
 * d'un serveur unique. C'est la MÊME constante que l'écran serveur propose par
 * défaut : les deux doivent rester d'accord, sinon on migre une base qui ne
 * correspond à aucun serveur — invisible en dev, fatal sur un téléphone où
 * `localhost` ne désigne rien.
 *
 * L'étape 5.3 la remplace par le serveur sélectionné, et ce commentaire meurt.
 */
export const SERVEUR_PAR_DEFAUT = 'http://localhost:3000';

export function useMigrationsLocales(): { pret: boolean; erreur: Error | null } {
  const { base } = ouvrirBase(SERVEUR_PAR_DEFAUT);
  const { success, error } = useMigrations(base, migrations);
  return { pret: success, erreur: error ?? null };
}
