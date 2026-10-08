/**
 * The pure part of the "My bots" page (`ui/bots.tsx`, RFC 0003,
 * `docs/protocol/BOTS.md`): the scopes in the server's order with their
 * sentence, the reference's routes grouped by scope, the wording of the
 * server's refusals, the key's expiry field, what an edit sends and the
 * ready-to-copy example.
 * Loadable by plain Node, tested in `ui/botsModel.test.ts`.
 */

import type { Bot, BotReference, BotRoute, BotScope, UpdateBot } from '../providers/rocketvibe/protocol.generated.ts';
import type { TranslationKey } from './messages.ts';

/** Every scope, in the order of `BotScope::ALL` (`crates/rv-protocol/src/bots.rs`). */
export const BOT_SCOPES: readonly BotScope[] = [
  'rooms:read',
  'messages:write',
  'files:write',
  'reactions:write',
  'rooms:join',
  'users:read',
  'dm:write',
];

/** What each scope lets a key do, in words; `always` is the group open to every key. */
export const SCOPE_TEXT: Record<BotScope | 'always', TranslationKey> = {
  'rooms:read': 'bots.scopeRoomsRead',
  'messages:write': 'bots.scopeMessagesWrite',
  'files:write': 'bots.scopeFilesWrite',
  'reactions:write': 'bots.scopeReactionsWrite',
  'rooms:join': 'bots.scopeRoomsJoin',
  'users:read': 'bots.scopeUsersRead',
  'dm:write': 'bots.scopeDmWrite',
  always: 'bots.scopeAlways',
};

/** The routes the reference lists for one scope (`always`: the group without one). */
export function scopeRoutes(reference: BotReference | null, scope: BotScope | 'always'): BotRoute[] {
  if (reference === null) return [];
  return reference.groups
    .filter((group) => (scope === 'always' ? group.scope == null : group.scope === scope))
    .flatMap((group) => group.routes);
}

/**
 * One route of the "API" disclosure: the method, the path, then any scope the
 * route needs besides its group's (`also`, e.g. completing an upload also
 * needs `messages:write`).
 */
export function routeLine(route: BotRoute): string {
  const also = (route.also ?? []).map((scope) => ` + ${scope}`).join('');
  return `${route.method.padEnd(6)} ${route.path}${also}`;
}

/** Toggles one scope, keeping the server's order (the comparison of an edit relies on it). */
export function toggleScope(scopes: readonly BotScope[], scope: BotScope): BotScope[] {
  const next = new Set(scopes);
  if (next.has(scope)) next.delete(scope);
  else next.add(scope);
  return BOT_SCOPES.filter((s) => next.has(s));
}

export function sameScopes(a: readonly BotScope[], b: readonly BotScope[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((s) => left.has(s));
}

/** Unicode `Cc`, what Rust's `char::is_control` refuses. */
const control = (ch: string) => {
  const code = ch.codePointAt(0)!;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

/**
 * A display name as the server takes it (`valid_display_name`,
 * `apps/server/src/bots.rs`): trimmed, 1 to 256 UTF-8 bytes, no control
 * character. `null` when it would be refused.
 */
export function botDisplayName(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || new TextEncoder().encode(trimmed).length > 256 || [...trimmed].some(control)) return null;
  return trimmed;
}

export type BotForm = { displayName: string; description: string; scopes: readonly BotScope[] };

/**
 * What saving a bot's page sends (`PATCH /api/v1/bots/{id}`, absent fields
 * kept): only the fields that changed, trimmed. `invalid` when the display
 * name would be refused, and then nothing is sent.
 */
export function botChanges(bot: Pick<Bot, 'user' | 'description' | 'scopes'>, form: BotForm): { changes: Omit<UpdateBot, 'operation_id'>; invalid: boolean } {
  const changes: Omit<UpdateBot, 'operation_id'> = {};
  const name = botDisplayName(form.displayName);
  if (name !== null && name !== bot.user.display_name) changes.display_name = name;
  const description = form.description.trim();
  if (description !== bot.description) changes.description = description;
  if (!sameScopes(form.scopes, bot.scopes)) changes.scopes = [...form.scopes];
  return { changes, invalid: name === null };
}

/**
 * The expiry field of a new key: empty means never (`null`), otherwise a whole
 * number of days from 1 to 3650 (`KEY_DAYS`); `undefined` for anything else.
 */
export function expiryDays(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,4}$/.test(trimmed)) return undefined;
  const days = Number(trimmed);
  return days >= 1 && days <= 3650 ? days : undefined;
}

/** The sentence for a refused bot call, from the server's error code. */
export function botErrorKey(code: string, status: number): TranslationKey {
  switch (code) {
    case 'bots_disabled':
      return 'bots.errDisabled';
    case 'bot_limit':
      return 'bots.errLimit';
    case 'bot_create_limit':
      return 'bots.errCreateLimit';
    case 'username_taken':
      return 'bots.errUsernameTaken';
    case 'bot_key_limit':
      return 'bots.errKeyLimit';
    case 'bot_disabled':
      return 'bots.errBotDisabled';
    case 'bot_key_replayed':
      return 'bots.errKeyReplayed';
    case 'reauthentication_required':
      return 'bots.errReauth';
    case 'invalid_request':
      return 'bots.errInvalid';
    case 'not_found':
      return 'bots.errNotFound';
    case 'bot_encrypted_room':
      return 'bots.errEncryptedRoom';
    case 'crypto_bot_member':
      return 'bots.errBotMember';
    case 'invalid_avatar':
      return 'bots.errInvalidAvatar';
    case 'avatar_too_large':
      return 'bots.errAvatarTooLarge';
    case 'avatar_busy':
      return 'bots.errAvatarBusy';
    case 'storage_unavailable':
      return 'bots.errStorageUnavailable';
  }
  if (status === 429) return 'bots.errRateLimited';
  if (status === 0 || status >= 500 || code === 'offline' || code === 'session_closed') return 'bots.errOffline';
  return 'bots.failed';
}

/**
 * A first call to try the key, ready to paste in a terminal: one message in a
 * room. The room stays a placeholder; the server's address and the key are
 * filled in.
 */
export function curlExample(baseUrl: string, key: string): string {
  const server = baseUrl.replace(/\/+$/, '');
  return (
    `curl -X POST "${server}/api/v1/rooms/<ROOM_ID>/messages" ` +
    `-H "Authorization: Bearer ${key}" ` +
    `-H "Content-Type: application/json" ` +
    `-d '{"operation_id":"hello-1","text":"Hello"}'`
  );
}
