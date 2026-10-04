import type { Config } from 'drizzle-kit';

/**
 * `driver: 'expo'` makes drizzle-kit generate a `migrations.js` importable
 * by `drizzle-orm/expo-sqlite/migrator`, in addition to the `.sql` files.
 */
export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  driver: 'expo',
} satisfies Config;
