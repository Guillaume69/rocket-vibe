import type { Config } from 'drizzle-kit';

/**
 * `driver: 'expo'` fait générer par drizzle-kit un `migrations.js` importable
 * par `drizzle-orm/expo-sqlite/migrator`, en plus des fichiers `.sql`.
 */
export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  driver: 'expo',
} satisfies Config;
