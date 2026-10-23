/**
 * Teams into the store's rows: the aggregator's chats and channels as rooms
 * and read states, the chat service's messages (HTML) as the markdown the
 * renderer reads, emotions as reactions. Mirrors
 * `apps/desktop/crates/rv-core/src/teams/translate.rs`.
 */

import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { MemberPage, RoomMember } from '../../lib/provider.ts';

type Doc = Record<string, unknown>;

/** A message id: the conversation and the server id, which is only unique within it. */
export function messageId(conversation: string, id: string): string {
  return `${conversation}/${id}`;
}

export function splitId(id: string): { rid: string; server: string } | null {
  const at = id.lastIndexOf('/');
  if (at <= 0) return null;
  const server = id.slice(at + 1);
  return /^\d+$/.test(server) ? { rid: id.slice(0, at), server } : null;
}

export function str(v: unknown, key: string): string | null {
  const value = (v as Doc | null)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A number Teams sends as a string or a number. */
export function int(v: unknown, key: string): number | null {
  const value = (v as Doc | null)?.[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function instant(v: unknown, key: string): number | null {
  const raw = str(v, key);
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/** The MRI at the end of a `from` contact link, or the MRI itself. */
export function mriOf(from: string): string {
  return from.slice(from.lastIndexOf('/') + 1);
}

/** The conversation a pushed or listed resource belongs to. */
export function conversationOf(resource: unknown): string | null {
  const link = str(resource, 'conversationLink') ?? str(resource, 'conversationid');
  if (!link) return null;
  const tail = link.split('/conversations/').pop() ?? link;
  const conversation = tail.split(';')[0] ?? tail;
  try {
    return decodeURIComponent(conversation) || null;
  } catch {
    return conversation || null;
  }
}

export function rootOf(resource: unknown, id: string): string | null {
  const root = str(resource, 'conversationLink')?.split(';messageid=')[1];
  return root && root !== id && /^\d+$/.test(root) ? root : null;
}

function emotions(raw: unknown): Doc[] {
  const value = ((raw as Doc)?.properties as Doc | undefined)?.emotions;
  if (Array.isArray(value)) return value as Doc[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Doc[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const KEYS: readonly (readonly [string, string])[] = [
  ['like', '+1'], ['heart', 'heart'], ['laugh', 'laughing'], ['surprised', 'open_mouth'], ['sad', 'cry'], ['angry', 'angry'],
];

/** The shortcode a reaction key shows as: a classic key, or a `<codepoints>_<name>` key's name. */
export function reactionCode(key: string): string {
  const classic = KEYS.find(([k]) => k === key);
  if (classic) return classic[1];
  const name = key.split('_').slice(1).join('_');
  return name || key;
}

/** The key a shortcode is sent as; only the classic keys are known to be accepted. */
export function reactionKey(shortcode: string): string | null {
  const code = shortcode.replace(/^:|:$/g, '');
  const alias: Record<string, string> = {
    thumbsup: '+1', thumbs_up: '+1', joy: 'laughing', satisfied: 'laughing', red_heart: 'heart',
    astonished: 'open_mouth', hushed: 'open_mouth', sob: 'cry', disappointed: 'cry', rage: 'angry',
  };
  const wanted = alias[code] ?? code;
  return KEYS.find(([, c]) => c === wanted)?.[0] ?? null;
}

/** People named by MRI: display names from messages, members and profiles. */
export class TeamsDirectory {
  private readonly names = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  remember(mri: string, name: string): void {
    const clean = name.trim();
    if (!mri || !clean || this.names.get(mri) === clean) return;
    this.names.set(mri, clean);
    for (const fn of this.listeners) fn();
  }

  name(mri: string): string | null {
    return this.names.get(mri) ?? null;
  }

  shown(mri: string): string {
    return this.names.get(mri) ?? mri;
  }

  /** The MRI known under this display name, only when exactly one carries it:
   *  a search hit names its author but gives no MRI. */
  mriFor(name: string): string | null {
    let found: string | null = null;
    for (const [mri, who] of this.names) {
      if (who !== name) continue;
      if (found !== null) return null;
      found = mri;
    }
    return found;
  }

  learn(raw: unknown): void {
    const from = str(raw, 'from'), name = str(raw, 'imdisplayname');
    if (from && name) this.remember(mriOf(from), name);
  }

  displayNames(): ReadonlyMap<string, string> {
    return this.names;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Teams' message HTML to markdown: paragraphs, breaks, emphasis, code, links,
 * lists, quotes, mentions (`@Name`) and emoji (`alt`). Scripts, styles and
 * remote images are dropped.
 */
export function htmlToMarkdown(html: string): string {
  let out = '';
  let rest = html;
  const lists: (number | null)[] = [];
  let link: string | null = null;
  let linkStart = 0;
  let pre = false;
  const push = (text: string) => {
    const decoded = decodeEntities(text);
    out += pre ? decoded : decoded.replace(/[\r\n]+/g, ' ').replace(/ /g, ' ');
  };
  for (;;) {
    const start = rest.indexOf('<');
    if (start < 0) break;
    push(rest.slice(0, start));
    rest = rest.slice(start);
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      rest = end < 0 ? '' : rest.slice(end + 3);
      continue;
    }
    const end = rest.indexOf('>');
    if (end < 0) { rest = ''; break; }
    const tag = rest.slice(1, end);
    rest = rest.slice(end + 1);
    const closing = tag.startsWith('/');
    const name = (/^\/?([a-z0-9]+)/i.exec(tag)?.[1] ?? '').toLowerCase();
    if ((name === 'script' || name === 'style') && !closing) {
      const close = rest.toLowerCase().indexOf(`</${name}`);
      rest = close < 0 ? '' : rest.slice(close);
      continue;
    }
    switch (name) {
      case 'br': out += '\n'; break;
      case 'p': case 'div': if (closing) out += '\n'; break;
      case 'b': case 'strong': out += '**'; break;
      case 'i': case 'em': out += '_'; break;
      case 's': case 'strike': case 'del': out += '~~'; break;
      case 'code': if (!pre) out += '`'; break;
      case 'pre': pre = !closing; out += '\n```\n'; break;
      case 'blockquote': out += closing ? '\n' : '\n> '; break;
      case 'ul': if (closing) { lists.pop(); out += '\n'; } else lists.push(null); break;
      case 'ol': if (closing) { lists.pop(); out += '\n'; } else lists.push(0); break;
      case 'li':
        if (!closing) {
          out += `\n${'  '.repeat(Math.max(0, lists.length - 1))}`;
          const top = lists.length - 1;
          if (top >= 0 && lists[top] !== null) { lists[top] = (lists[top] ?? 0) + 1; out += `${lists[top]}. `; } else out += '- ';
        }
        break;
      case 'a':
        if (!closing) {
          const href = attribute(tag, 'href');
          link = href && /^https?:\/\//i.test(href) ? decodeEntities(href) : null;
          linkStart = out.length;
        } else if (link) {
          const text = out.slice(linkStart).trim();
          out = out.slice(0, linkStart) + (text === '' || text === link ? link : `[${text}](${link})`);
          link = null;
        }
        break;
      case 'span':
        if (!closing && attribute(tag, 'itemtype')?.endsWith('/Mention')) out += '@';
        break;
      case 'img': {
        const alt = attribute(tag, 'alt');
        if (alt && attribute(tag, 'itemtype')?.endsWith('/Emoji')) out += decodeEntities(alt);
        break;
      }
    }
  }
  push(rest);
  return out.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function bodyText(raw: unknown): string {
  const content = str(raw, 'content') ?? '';
  const html = (str(raw, 'messagetype') ?? '').startsWith('RichText') || (str(raw, 'contenttype') ?? '').toLowerCase() === 'html';
  return html ? htmlToMarkdown(content) : decodeEntities(content).trim();
}

export function deleted(raw: unknown): boolean {
  return (int((raw as Doc)?.properties, 'deletetime') ?? 0) > 0;
}

function tagValue(xml: string, tag: string): string | null {
  const start = xml.indexOf(`<${tag}>`);
  if (start < 0) return null;
  const from = start + tag.length + 2;
  const end = xml.indexOf(`</${tag}>`, from);
  return end < 0 ? null : xml.slice(from, end);
}

function system(raw: unknown, directory: TeamsDirectory): { type: string; text: string | null } | null {
  const kind = str(raw, 'messagetype')?.replace(/^ThreadActivity\//, '');
  if (!kind || kind === str(raw, 'messagetype')) return null;
  const content = str(raw, 'content') ?? '';
  const target = tagValue(content, 'target') ?? tagValue(content, 'id');
  switch (kind) {
    case 'AddMember': return { type: 'au', text: target ? directory.shown(target) : null };
    case 'DeleteMember': return { type: 'ru', text: target ? directory.shown(target) : null };
    case 'TopicUpdate': {
      const value = tagValue(content, 'value');
      return { type: 'room_changed_topic', text: value === null ? null : decodeEntities(value) };
    }
    default: return null;
  }
}

function reactions(raw: unknown, directory: TeamsDirectory): string | null {
  const grouped: Record<string, { usernames: string[] }> = {};
  for (const emotion of emotions(raw)) {
    const key = str(emotion, 'key');
    if (!key) continue;
    const users = (Array.isArray(emotion.users) ? emotion.users : []).map((u) => str(u, 'mri')).filter((m): m is string => m !== null).map((m) => directory.shown(m));
    if (users.length > 0) grouped[`:${reactionCode(key)}:`] = { usernames: users };
  }
  return Object.keys(grouped).length > 0 ? JSON.stringify(grouped) : null;
}

/** Whether I am among a message's reactions under `key`. */
export function reacted(raw: unknown, key: string, me: string): boolean {
  return emotions(raw).some((e) => str(e, 'key') === key && Array.isArray(e.users) && e.users.some((u) => str(u, 'mri') === me));
}

/** A url Graph can resolve through `/shares`: a SharePoint or OneDrive host.
 *  Teams shared files live there; AMS media (call recordings) does not, so it
 *  is never offered as a download that would fail. */
export function isGraphShare(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.sharepoint.com') || host.endsWith('.sharepoint-df.com') || host === '1drv.ms';
  } catch {
    return false;
  }
}

/** File attachments from the chat service `properties.files` (a JSON string):
 *  each `{title, fileInfo.fileUrl}`. Only SharePoint/OneDrive files are kept
 *  (downloaded through Graph `/shares`), as the renderer's RC shape. */
export function fileAttachments(raw: unknown): string | null {
  const props = (raw as Doc).properties as Doc | undefined;
  const files = props?.files;
  let parsed: unknown = files;
  if (typeof files === 'string') {
    try { parsed = JSON.parse(files); } catch { return null; }
  }
  if (!Array.isArray(parsed)) return null;
  const out: Doc[] = [];
  for (const f of parsed as Doc[]) {
    const info = f?.fileInfo as Doc | undefined;
    const url = str(info, 'fileUrl') ?? str(f, 'fileUrl');
    if (!url || !isGraphShare(url)) continue;
    const name = str(f, 'title') ?? str(f, 'filename') ?? str(f, 'fileName') ?? 'file';
    const a: Doc = { title: name, title_link: url, type: 'file' };
    const size = int(info, 'fileSize') ?? int(f, 'size');
    if (size !== null) a.size = size;
    out.push(a);
  }
  return out.length ? JSON.stringify(out) : null;
}

/**
 * A Teams call (`Event/Call`) as the call message kChat's and Slack's calls
 * also become. Its start (`callStarted`) is a running call whose call id is
 * its conversation: Join opens the conversation in Teams (`channelLink` /
 * `chatLink`), where the running call is joined. Its end is a separate event,
 * in a channel a reply on the start, carrying each participant's
 * `<duration>`: it is drawn in the start's place (the start's id and time, a
 * Teams message id being its arrival time), and being newer it replaces the
 * running card whichever arrives first. Mirrors `call_card` in
 * `apps/desktop/crates/rv-core/src/teams/translate.rs`.
 */
function callMessage(conversation: string, raw: unknown, id: string, directory: TeamsDirectory): LocalMessage | null {
  const content = str(raw, 'content') ?? '';
  const event = (tagValue(content, 'callEventType') ?? '').toLowerCase();
  const ended = content.includes('<ended/>') || event === 'callended';
  if (!ended && event !== 'callstarted') return null;
  const at = instant(raw, 'originalarrivaltime') ?? instant(raw, 'composetime') ?? Number(id);
  if (!Number.isFinite(at)) return null;
  directory.learn(raw);
  const author = mriOf(str(raw, 'from') ?? '');
  const parent = str(raw, 'parentMessageId') ?? (int(raw, 'parentMessageId') !== null ? String(int(raw, 'parentMessageId')) : null);
  const root = rootOf(raw, id);
  const start = root ?? (parent && parent !== id && /^\d+$/.test(parent) ? parent : null);
  const seconds = [...content.matchAll(/<duration>\s*(\d+)\s*<\/duration>/g)].map((m) => Number(m[1]));
  return {
    id: messageId(conversation, ended && start ? start : id),
    rid: conversation,
    text: ended ? (seconds.length ? String(Math.max(...seconds)) : '') : '',
    ts: ended && start ? Number(start) : at,
    authorId: author,
    authorName: directory.shown(author),
    systemType: ended ? 'videoconf-ended' : 'videoconf',
    threadId: !ended && root ? messageId(conversation, root) : null,
    threadCount: 0,
    threadLast: null,
    threadShown: false,
    editedAt: null,
    md: null,
    attachments: null,
    reactions: null,
    urls: null,
    callId: ended ? null : conversation,
    encryptedRaw: null,
    pinned: false,
    starred: null,
    updatedAt: Math.max(at, int(raw, 'version') ?? 0),
  };
}

/** A channel's page in Teams, where its running call shows a Join. */
export function channelLink(channel: string, name: string, group: string, tenant: string): string {
  const query = new URLSearchParams({ groupId: group, tenantId: tenant });
  return `https://teams.microsoft.com/l/channel/${encodeURIComponent(channel)}/${encodeURIComponent(name)}?${query}`;
}

/** A chat's page in Teams, where its running call shows a Join. */
export function chatLink(chat: string, tenant: string): string {
  return `https://teams.microsoft.com/l/chat/${encodeURIComponent(chat)}/conversations?${new URLSearchParams({ tenantId: tenant })}`;
}

/** One chat service message, or null for a kind the app does not show. */
export function toMessage(conversation: string, raw: unknown, directory: TeamsDirectory): LocalMessage | null {
  const id = str(raw, 'id') ?? (int(raw, 'id') !== null ? String(int(raw, 'id')) : null);
  const kind = str(raw, 'messagetype') ?? '';
  if (kind === 'Event/Call') return id && !deleted(raw) ? callMessage(conversation, raw, id, directory) : null;
  const attachments = fileAttachments(raw);
  const shown =
    kind === 'Text' || kind === 'RichText/Html' || kind === 'RichText' || kind.startsWith('ThreadActivity/') || attachments !== null;
  if (!id || !shown || deleted(raw)) return null;
  directory.learn(raw);
  const activity = system(raw, directory);
  if (kind.startsWith('ThreadActivity/') && !activity) return null;
  const ts = instant(raw, 'originalarrivaltime') ?? instant(raw, 'composetime') ?? Number(id);
  if (!Number.isFinite(ts)) return null;
  const author = mriOf(str(raw, 'from') ?? '');
  const edited = int((raw as Doc).properties, 'edittime');
  const root = rootOf(raw, id);
  return {
    id: messageId(conversation, id),
    rid: conversation,
    text: activity ? activity.text : bodyText(raw),
    ts,
    authorId: author,
    authorName: directory.shown(author),
    systemType: activity?.type ?? null,
    threadId: root ? messageId(conversation, root) : null,
    threadCount: 0,
    threadLast: null,
    threadShown: false,
    editedAt: edited && edited > 0 ? edited : null,
    md: null,
    attachments,
    reactions: reactions(raw, directory),
    urls: null,
    callId: null,
    encryptedRaw: null,
    pinned: ((raw as Doc).properties as Doc | null | undefined)?.pinned != null,
    starred: null,
    updatedAt: Math.max(edited && edited > 0 ? edited : ts, int(raw, 'version') ?? 0),
  };
}

/** A short profile row (middle tier `fetchShortProfile`) as the profile card's
 *  fields. A missing row still yields the name we already learned from messages,
 *  so the card shows a name rather than an MRI even when the profile call fails. */
export function profileFields(mri: string, row: unknown, directory: TeamsDirectory): Record<string, unknown> {
  const name = str(row, 'displayName') ?? directory.name(mri);
  if (name) directory.remember(mri, name);
  const upn = str(row, 'userPrincipalName') ?? str(row, 'email');
  const title = str(row, 'jobTitle');
  return {
    _id: mri,
    username: upn ?? mri,
    name: name ?? mri,
    roles: [],
    bio: title && title !== '' ? title : null,
    bot: mri.startsWith('28:'),
  };
}

/** The `threadProperties.topic` of a chat-service conversation, when set. The
 *  live shape (probed 2026-10-22) carries a real topic but no description or
 *  member count there, so those are left for the members list. */
export function conversationTopic(doc: unknown): string | null {
  const props = (doc as { threadProperties?: unknown } | null | undefined)?.threadProperties;
  const value = str(props, 'topic');
  return value && value.trim() !== '' ? value : null;
}

/** Substrate search hits for one room as messages. Keeps only hits whose
 *  conversation is `rid`. Substrate indexes Teams messages from Exchange, so a
 *  hit has no chat-service message id (the id is synthetic, prefixed so it never
 *  collides with a real one) and names the author without an MRI (resolved from
 *  the directory when known). */
export function searchHits(body: unknown, rid: string, directory: TeamsDirectory): LocalMessage[] {
  const sets = (body as { EntitySets?: unknown } | null | undefined)?.EntitySets;
  const first = Array.isArray(sets) ? (sets[0] as { ResultSets?: unknown } | undefined) : undefined;
  const resultSets = Array.isArray(first?.ResultSets) ? (first.ResultSets[0] as { Results?: unknown } | undefined) : undefined;
  const results = resultSets?.Results;
  if (!Array.isArray(results)) return [];
  const out: LocalMessage[] = [];
  for (const hit of results) {
    const source = (hit as { Source?: unknown } | null | undefined)?.Source;
    if (!source) continue;
    if (str(source, 'ClientConversationId') !== rid && str(source, 'ClientThreadId') !== rid) continue;
    const sent = str(source, 'DateTimeSent');
    const ts = sent ? Date.parse(sent) : NaN;
    if (!Number.isFinite(ts)) continue;
    const email = (source as { From?: { EmailAddress?: unknown } }).From?.EmailAddress;
    const name = str(email, 'Name');
    const item = str(source, 'ImmutableId') ?? str(source, 'ItemId') ?? str(source, 'Id') ?? 'hit';
    out.push({
      id: `${rid}/search:${item}`,
      rid,
      text: str(source, 'Preview'),
      ts,
      authorId: (name && directory.mriFor(name)) || '',
      authorName: name,
      systemType: null,
      threadId: null,
      threadCount: 0,
      threadLast: null,
      threadShown: false,
      editedAt: null,
      md: null,
      attachments: null,
      reactions: null,
      urls: null,
      callId: null,
      encryptedRaw: null,
      pinned: false,
      starred: null,
      updatedAt: ts,
    });
  }
  return out;
}

/** A threads-service roster as a member page: each row is `{id: <mri>, role}`,
 *  the name resolved from the directory, optionally filtered by display name.
 *  Read-only: Teams gives no add/remove/role-change route here. */
export function rosterPage(body: unknown, directory: TeamsDirectory, filter: string): MemberPage {
  const rows = (body as { members?: unknown } | null | undefined)?.members;
  const needle = filter.trim().toLowerCase();
  const members: RoomMember[] = [];
  if (Array.isArray(rows)) {
    for (const m of rows) {
      const mri = str(m, 'id');
      if (!mri) continue;
      const name = directory.name(mri);
      const username = directory.shown(mri);
      if (needle && !username.toLowerCase().includes(needle) && !(name ?? '').toLowerCase().includes(needle)) continue;
      const role = str(m, 'role');
      members.push({ id: mri, username, name, status: null, avatarEtag: null, roles: role ? [role] : [] });
    }
  }
  return { members, total: members.length };
}

function preview(last: unknown, directory: TeamsDirectory): { text: string; author: string | null; at: number } | null {
  const kind = str(last, 'messageType') ?? '';
  if (kind !== 'Text' && kind !== 'RichText/Html' && kind !== 'RichText') return null;
  const from = str(last, 'from');
  const name = str(last, 'imDisplayName');
  if (from && name) directory.remember(mriOf(from), name);
  const at = instant(last, 'composeTime') ?? int(last, 'id');
  if (at === null) return null;
  return { text: bodyText({ content: (last as Doc).content, messagetype: kind }), author: from ? directory.shown(mriOf(from)) : null, at };
}

function lastAt(entry: unknown): number | null {
  const last = (entry as Doc)?.lastMessage;
  return last ? (instant(last, 'composeTime') ?? int(last, 'id')) : null;
}

/** An aggregator chat as a room. */
export function chatRoom(me: string, chat: unknown, directory: TeamsDirectory): LocalRoom | null {
  const rid = str(chat, 'id');
  if (!rid) return null;
  const members = (Array.isArray((chat as Doc).members) ? ((chat as Doc).members as Doc[]) : [])
    .map((m) => str(m, 'mri')).filter((m): m is string => m !== null && m !== me);
  const meeting = str(chat, 'chatType') === 'meeting';
  const oneOnOne = (chat as Doc).isOneOnOne === true;
  const last = preview((chat as Doc).lastMessage, directory);
  const others = members.map((m) => directory.shown(m));
  const display = str(chat, 'title') ?? (others.length > 0 ? others.join(', ') : null);
  const at = last?.at ?? lastAt(chat);
  return {
    rid,
    type: meeting ? 'p' : 'd',
    name: display ?? rid,
    displayName: display,
    encrypted: false,
    readOnly: false,
    dmOtherUid: oneOnOne ? (members[0] ?? null) : null,
    dmOtherUsername: null,
    lastMessage: last?.text ?? null,
    lastMessageType: null,
    lastMessageTs: at,
    keepPreview: last === null,
    avatarEtag: null,
    updatedAt: at ?? instant(chat, 'createdAt') ?? 0,
  };
}

/** An aggregator channel as a room. */
export function channelRoom(channel: unknown, directory: TeamsDirectory): LocalRoom | null {
  const rid = str(channel, 'id');
  if (!rid) return null;
  const name = str(channel, 'displayName') ?? 'General';
  const last = preview((channel as Doc).lastMessage, directory);
  const at = last?.at ?? lastAt(channel);
  const standard = (str(channel, 'channelType') ?? 'Standard') === 'Standard';
  return {
    rid,
    type: standard ? 'c' : 'p',
    name,
    displayName: name,
    encrypted: false,
    readOnly: false,
    dmOtherUid: null,
    dmOtherUsername: null,
    lastMessage: last?.text ?? null,
    lastMessageType: null,
    lastMessageTs: at,
    keepPreview: last === null,
    avatarEtag: null,
    updatedAt: at ?? 0,
  };
}

export function horizon(entry: unknown): number | null {
  const value = int((entry as Doc)?.consumptionHorizon, 'originalArrivalTime');
  return value && value > 0 ? value : null;
}

/** A chat's or channel's read state. Teams gives no count: an unread room counts one. */
export function toSubscription(rid: string, entry: unknown, me: string, team: { id: string; name: string } | null): LocalSubscription {
  const doc = entry as Doc;
  const flag = typeof doc.isRead === 'boolean' ? doc.isRead : typeof doc.isMessageRead === 'boolean' ? doc.isMessageRead : null;
  const from = str(doc.lastMessage, 'from');
  const mine = doc.isLastMessageFromMe === true || (from !== null && mriOf(from) === me);
  const last = lastAt(entry), seen = horizon(entry);
  const newer = last !== null && (seen === null || last > seen);
  const unread = !mine && (flag === null ? newer : !flag);
  const hidden = doc.hidden === true || doc.isConversationDeleted === true;
  return {
    rid,
    subId: rid,
    unread: unread ? 1 : 0,
    mentions: 0,
    groupMentions: 0,
    alert: unread,
    open: !hidden,
    favorite: doc.isFavorite === true,
    lastSeen: seen,
    roles: null,
    groupId: team?.id ?? null,
    groupName: team?.name ?? null,
    groupRank: null,
    e2eKey: null,
    e2eKeyId: null,
    updatedAt: Date.now(),
  };
}
