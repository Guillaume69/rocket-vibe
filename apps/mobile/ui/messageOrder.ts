/** Ordering belongs to the provider, while the message renderer stays shared. */
import { desc, sql, type SQL } from 'drizzle-orm';
import { messages } from '../db/schema.ts';
export function messageOrder(mode?: 'sequence'): SQL[] {
  if (mode !== 'sequence') return [desc(messages.ts),desc(messages.id)];
  return [
    sql`(SELECT position FROM native_positions WHERE id=${messages.id}) IS NULL DESC`,
    sql`(SELECT length(position) FROM native_positions WHERE id=${messages.id}) DESC`,
    sql`(SELECT position FROM native_positions WHERE id=${messages.id}) DESC`,
    desc(messages.ts),desc(messages.id),
  ];
}
