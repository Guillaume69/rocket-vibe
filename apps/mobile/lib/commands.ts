/**
 * Slash commands: the server's list (`commands.list`), what the composer
 * suggests after a leading `/`, and the draft a send turns into a command
 * (`commands.run`).
 *
 * `commands.run` answers `{ success: true }` even when the command fails: its
 * reply (error, `/help`) arrives as a private message on
 * `stream-notify-user` / `<uid>/message`, never in the REST response (probed on
 * 8.5). Same logic as `apps/desktop/crates/rv-core/src/commands.rs`.
 */

import type { ClientRest } from './rest.ts';

type Language = 'fr' | 'en';

export type Command = {
  name: string;
  /** Shown after the name, as to be typed: `@username`, `#channel`, "your message". */
  params: string;
  description: string;
  /** Any one suffices; empty, anyone can run it. */
  permissions: string[];
};

export const COMMAND_SUGGESTION_LIMIT = 8;

/** (key, French, English) of the core commands' descriptions and parameters. */
const WORDS: readonly (readonly [string, string, string])[] = [
  ['Archive', 'Archiver le salon', 'Archive the room'],
  ['Unarchive', 'Désarchiver le salon', 'Unarchive the room'],
  ['Ban_user_from_room', "Bannir quelqu'un du salon", 'Ban someone from the room'],
  ['Unban_user_from_room', 'Lever le bannissement', 'Unban someone from the room'],
  ['Create_A_New_Channel', 'Créer un salon', 'Create a new channel'],
  ['Show_the_keyboard_shortcut_list', 'Afficher les raccourcis clavier', 'Show the keyboard shortcuts'],
  ['Hide_room', 'Masquer le salon', 'Hide the room'],
  ['Invite_user_to_join_channel', "Inviter quelqu'un dans ce salon", 'Invite someone to this room'],
  [
    'Invite_user_to_join_channel_all_to',
    "Inviter tous les membres d'ici dans [#salon]",
    'Invite everyone here to [#channel]',
  ],
  [
    'Invite_user_to_join_channel_all_from',
    'Inviter ici tous les membres de [#salon]',
    'Invite everyone from [#channel] here',
  ],
  ['Join_the_given_channel', 'Rejoindre le salon', 'Join the channel'],
  ['Remove_someone_from_room', "Retirer quelqu'un du salon", 'Remove someone from the room'],
  ['Leave_the_current_channel', 'Quitter ce salon', 'Leave this room'],
  ['Displays_action_text', 'Écrire une action', 'Write an action'],
  ['Direct_message_someone', "Écrire en privé à quelqu'un", 'Message someone directly'],
  ['Mute_someone_in_room', "Rendre quelqu'un muet ici", 'Mute someone in the room'],
  ['Unmute_someone_in_room', "Rendre la parole à quelqu'un", 'Unmute someone in the room'],
  ['Slash_Status_Description', 'Changer ton message de statut', 'Set your status message'],
  ['Slash_Status_Params', 'message de statut', 'status message'],
  ['Slash_Topic_Description', 'Changer le sujet du salon', "Set the room's topic"],
  ['Slash_Topic_Params', 'sujet', 'topic'],
  ['Slash_Gimme_Description', 'Met ༼ つ ◕_◕ ༽つ devant ton message', 'Puts ༼ つ ◕_◕ ༽つ before your message'],
  ['Slash_LennyFace_Description', 'Met ( ͡° ͜ʖ ͡°) après ton message', 'Puts ( ͡° ͜ʖ ͡°) after your message'],
  ['Slash_Shrug_Description', 'Met ¯\\_(ツ)_/¯ après ton message', 'Puts ¯\\_(ツ)_/¯ after your message'],
  ['Slash_Tableflip_Description', 'Met (╯°□°）╯︵ ┻━┻ après ton message', 'Puts (╯°□°）╯︵ ┻━┻ after your message'],
  ['Slash_TableUnflip_Description', 'Met ┬─┬ ノ( ゜-゜ノ) après ton message', 'Puts ┬─┬ ノ( ゜-゜ノ) after your message'],
  ['your_message', 'ton message', 'your message'],
  ['your_message_optional', 'ton message (facultatif)', 'your message (optional)'],
];

/**
 * The server sends i18n keys (`Slash_Shrug_Description`) where the web client
 * has its catalogue: ours covers the core commands, and an app's key at least
 * reads as words.
 */
export function words(key: string, language: Language): string {
  const known = WORDS.find(([k]) => k === key);
  if (known !== undefined) return language === 'fr' ? known[1] : known[2];
  const looksLikeKey = !/\s/.test(key) && key.includes('_') && /[A-Z]/.test(key);
  return looksLikeKey ? key.replaceAll('_', ' ') : key;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The commands `commands.list` returns, their i18n keys put into words. */
export function readCommands(response: unknown, language: Language): Command[] {
  const list = (response as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return [];
  const commands: Command[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const name = asString(raw.command);
    if (name === '') continue;
    const p = raw.permission;
    const permissions =
      typeof p === 'string' ? [p] : Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    commands.push({
      name,
      params: words(asString(raw.params), language),
      description: words(asString(raw.description), language),
      permissions,
    });
  }
  return commands;
}

/**
 * The command name being typed: the draft starts with `/` and the cursor has
 * not left its first word.
 */
export function detectCommandToken(text: string, cursor: number): { query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  if (!before.startsWith('/')) return null;
  const query = before.slice(1);
  if (/\s/.test(query) || query.includes('/')) return null;
  return { query };
}

/**
 * The commands whose name starts with `query`, those I am allowed to run when
 * my permissions are known (`null`: the server decides), sorted by name.
 */
export function completeCommand(
  commands: readonly Command[],
  query: string,
  granted: readonly string[] | null,
  limit = COMMAND_SUGGESTION_LIMIT,
): Command[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .filter((c) => granted === null || c.permissions.length === 0 || c.permissions.some((p) => granted.includes(p)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
}

/**
 * (name, parameters) of a draft that reads as a command: a leading `/name`,
 * then what follows. The caller checks that the server knows this name.
 */
export function splitCommand(text: string): { name: string; params: string } | null {
  const rest = text.trimStart();
  if (!rest.startsWith('/')) return null;
  const body = rest.slice(1);
  const firstSpace = body.search(/\s/);
  const name = firstSpace === -1 ? body : body.slice(0, firstSpace);
  if (name === '' || name.includes('/')) return null;
  return { name, params: firstSpace === -1 ? '' : body.slice(firstSpace).trim() };
}

/** Event key of private messages, on `stream-notify-user`. */
export const PRIVATE_MESSAGE_EVENT = 'message';

/** `<uid>/message` args: `[{ rid, msg, private: true, … }]` → (rid, text). */
export function privateMessage(args: readonly unknown[]): { rid: string; text: string } | null {
  const m = args[0] as { rid?: unknown; msg?: unknown } | undefined;
  const rid = asString(m?.rid);
  const text = asString(m?.msg).trim();
  if (rid === '' || text === '') return null;
  return { rid, text };
}

const cached = new Map<string, Promise<unknown>>();

/** `commands.list`, read once per session and account; a failure is not cached. */
export function rawList(client: Pick<ClientRest, 'get' | 'baseUrl' | 'auth'>): Promise<unknown> {
  const key = `${client.baseUrl}|${client.auth?.userId ?? ''}`;
  const known = cached.get(key);
  if (known !== undefined) return known;
  const request = client.get<unknown>('commands.list', { params: { count: 0 } });
  cached.set(key, request);
  request.catch(() => cached.delete(key));
  return request;
}

/**
 * Runs `text` as a command when it names one the server knows: `false` when it
 * is a message to send. Rejects if the server refuses it.
 */
export async function runCommand(
  client: Pick<ClientRest, 'get' | 'post' | 'baseUrl' | 'auth'>,
  rid: string,
  text: string,
  threadId: string | null,
): Promise<boolean> {
  const split = splitCommand(text);
  if (split === null) return false;
  let known: Command[];
  try {
    known = readCommands(await rawList(client), 'en');
  } catch {
    return false;
  }
  if (!known.some((c) => c.name === split.name)) return false;
  const body: Record<string, string> = {
    command: split.name,
    roomId: rid,
    params: split.params,
    triggerId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  };
  if (threadId !== null) body.tmid = threadId;
  await client.post('commands.run', { body });
  return true;
}
