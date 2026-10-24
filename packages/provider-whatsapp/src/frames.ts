/**
 * The WhatsApp engine's frames and commands (apps/desktop/whatsapp/engine),
 * the same JSON objects the desktop helper speaks over its pipes and
 * `rv-core/src/whatsapp.rs` reads. Unknown frames are skipped: a newer
 * engine may say more.
 */

export type WaMessage = {
  id: string;
  chat: string;
  name: string;
  sender: string;
  author: string;
  text: string;
  ts: number;
  mine: boolean;
  status?: string;
  edited?: boolean;
  deleted?: boolean;
  receipt?: string;
  reply_to?: string;
  quote_sender?: string;
  quote_text?: string;
  kind?: string;
  mime?: string;
  file_name?: string;
  size?: number;
  width?: number;
  height?: number;
  seconds?: number;
  link_url?: string;
  link_title?: string;
  link_description?: string;
  link_image?: boolean;
};

export type WaReaction = { message: string; sender: string; emoji: string; ts: number };

export type WaFrame =
  | { type: 'qr'; code: string; expires_ms: number }
  | { type: 'pairing_code'; code: string }
  | { type: 'status'; state: string }
  | { type: 'error'; code: string; id?: string }
  | { type: 'sent'; id: string; state?: string }
  | { type: 'message'; message: WaMessage }
  | { type: 'names'; names?: Record<string, string> }
  | { type: 'avatar'; jid: string; data?: string }
  | { type: 'reaction'; reaction: WaReaction }
  | { type: 'reload' }
  | { type: 'replayed' }
  | { type: 'chat'; jid: string; unread?: number }
  | { type: 'account'; jid: string; name?: string }
  | { type: 'typing'; typing: { chat: string; sender: string; state: string } }
  | { type: 'file'; id: string; path?: string }
  | { type: 'found'; id: string; people?: { jid: string; name: string }[] };

/** A frame from the engine, or null when it is not one this app reads. */
export function parseFrame(json: string): WaFrame | null {
  try {
    const value = JSON.parse(json) as { type?: unknown };
    return typeof value?.type === 'string' ? (value as WaFrame) : null;
  } catch {
    return null;
  }
}

/** The errors that end the engine (`rv-core/src/whatsapp.rs`); any other leaves it running. */
export const FATAL_ERRORS: ReadonlySet<string> = new Set([
  'connector_start_failed', 'secure_storage_failed', 'session_ended', 'pairing_failed', 'client_outdated',
  'connection_failed', 'state_removal_failed',
]);

/** `+33612345678` for a phone number's JID, its user part otherwise. */
export function fallbackName(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at);
  return jid.slice(at + 1) === 's.whatsapp.net' ? `+${user}` : user;
}

export const isGroup = (jid: string): boolean => jid.endsWith('@g.us');
