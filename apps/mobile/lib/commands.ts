/**
 * Commandes slash : la liste du serveur (`commands.list`), ce que le composer
 * propose après un `/` en tête de message, et le brouillon qu'un envoi
 * transforme en commande (`commands.run`).
 *
 * `commands.run` répond `{ success: true }` même quand la commande échoue :
 * sa réponse (erreur, `/help`) arrive en message privé sur
 * `stream-notify-user` / `<uid>/message`, jamais dans la réponse REST (sondé
 * sur 8.5). Même logique que `apps/desktop/crates/rv-core/src/commands.rs`.
 */

import type { ClientRest } from './rest.ts';

type Langue = 'fr' | 'en';

export type Command = {
  name: string;
  /** Affichés après le nom, tels qu'à taper : `@username`, `#channel`, « ton message ». */
  params: string;
  description: string;
  /** L'une suffit ; vide, tout le monde peut la lancer. */
  permissions: string[];
};

export const COMMAND_SUGGESTION_LIMIT = 8;

/** (clé, français, anglais) des descriptions et paramètres des commandes du cœur. */
const MOTS: readonly (readonly [string, string, string])[] = [
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
 * Le serveur envoie des clés i18n (`Slash_Shrug_Description`) là où le client
 * web a son catalogue : le nôtre couvre les commandes du cœur, et la clé
 * d'une app se lit au moins comme des mots.
 */
export function words(cle: string, langue: Langue): string {
  const connu = MOTS.find(([k]) => k === cle);
  if (connu !== undefined) return langue === 'fr' ? connu[1] : connu[2];
  const ressembleACle = !/\s/.test(cle) && cle.includes('_') && /[A-Z]/.test(cle);
  return ressembleACle ? cle.replaceAll('_', ' ') : cle;
}

const chaine = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Les commandes que rend `commands.list`, leurs clés i18n mises en mots. */
export function readCommands(reponse: unknown, langue: Langue): Command[] {
  const liste = (reponse as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(liste)) return [];
  const commandes: Command[] = [];
  for (const brute of liste as Record<string, unknown>[]) {
    const nom = chaine(brute.command);
    if (nom === '') continue;
    const p = brute.permission;
    const permissions =
      typeof p === 'string' ? [p] : Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    commandes.push({
      name: nom,
      params: words(chaine(brute.params), langue),
      description: words(chaine(brute.description), langue),
      permissions,
    });
  }
  return commandes;
}

/**
 * Le nom de commande en cours de frappe : le brouillon commence par `/` et
 * le curseur n'a pas quitté son premier mot.
 */
export function detectCommandToken(texte: string, curseur: number): { query: string } | null {
  const avant = texte.slice(0, Math.max(0, Math.min(curseur, texte.length)));
  if (!avant.startsWith('/')) return null;
  const requete = avant.slice(1);
  if (/\s/.test(requete) || requete.includes('/')) return null;
  return { query: requete };
}

/**
 * Les commandes dont le nom commence par `requete`, celles que j'ai le droit
 * de lancer quand mes permissions sont connues (`null` : on laisse le serveur
 * trancher), triées par nom.
 */
export function completeCommand(
  commandes: readonly Command[],
  requete: string,
  accordees: readonly string[] | null,
  limite = COMMAND_SUGGESTION_LIMIT,
): Command[] {
  const q = requete.toLowerCase();
  return commandes
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .filter((c) => accordees === null || c.permissions.length === 0 || c.permissions.some((p) => accordees.includes(p)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limite);
}

/**
 * (nom, paramètres) d'un brouillon qui se lit comme une commande : `/nom` en
 * tête, puis ce qui suit. L'appelant vérifie que le serveur connaît ce nom.
 */
export function splitCommand(texte: string): { name: string; params: string } | null {
  const reste = texte.trimStart();
  if (!reste.startsWith('/')) return null;
  const corps = reste.slice(1);
  const blanc = corps.search(/\s/);
  const nom = blanc === -1 ? corps : corps.slice(0, blanc);
  if (nom === '' || nom.includes('/')) return null;
  return { name: nom, params: blanc === -1 ? '' : corps.slice(blanc).trim() };
}

/** Clé d'événement des messages privés, sur `stream-notify-user`. */
export const PRIVATE_MESSAGE_EVENT = 'message';

/** `<uid>/message` args : `[{ rid, msg, private: true, … }]` → (rid, texte). */
export function privateMessage(args: readonly unknown[]): { rid: string; text: string } | null {
  const m = args[0] as { rid?: unknown; msg?: unknown } | undefined;
  const rid = chaine(m?.rid);
  const texte = chaine(m?.msg).trim();
  if (rid === '' || texte === '') return null;
  return { rid, text: texte };
}

const enCache = new Map<string, Promise<unknown>>();

/** `commands.list`, lu une fois par session et par compte ; un échec n'est pas retenu. */
export function rawList(client: Pick<ClientRest, 'get' | 'baseUrl' | 'auth'>): Promise<unknown> {
  const cle = `${client.baseUrl}|${client.auth?.userId ?? ''}`;
  const connue = enCache.get(cle);
  if (connue !== undefined) return connue;
  const lecture = client.get<unknown>('commands.list', { params: { count: 0 } });
  enCache.set(cle, lecture);
  lecture.catch(() => enCache.delete(cle));
  return lecture;
}

/**
 * Lance `texte` comme commande quand il en nomme une que le serveur connaît :
 * `false` quand c'est un message à envoyer. Rejette si le serveur la refuse.
 */
export async function runCommand(
  client: Pick<ClientRest, 'get' | 'post' | 'baseUrl' | 'auth'>,
  rid: string,
  texte: string,
  filId: string | null,
): Promise<boolean> {
  const decoupe = splitCommand(texte);
  if (decoupe === null) return false;
  let connues: Command[];
  try {
    connues = readCommands(await rawList(client), 'en');
  } catch {
    return false;
  }
  if (!connues.some((c) => c.name === decoupe.name)) return false;
  const corps: Record<string, string> = {
    command: decoupe.name,
    roomId: rid,
    params: decoupe.params,
    triggerId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  };
  if (filId !== null) corps.tmid = filId;
  await client.post('commands.run', { body: corps });
  return true;
}
