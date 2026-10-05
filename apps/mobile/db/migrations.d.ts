/** `drizzle-kit generate --driver=expo` produces an untyped `migrations.js`. */
declare module '*/migrations/migrations.js' {
  const migrations: { log: unknown; migrations: Record<string, string> };
  export default migrations;
}
