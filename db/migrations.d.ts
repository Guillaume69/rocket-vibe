/** `drizzle-kit generate --driver=expo` produit un `migrations.js` sans types. */
declare module '*/migrations/migrations.js' {
  const migrations: { journal: unknown; migrations: Record<string, string> };
  export default migrations;
}
