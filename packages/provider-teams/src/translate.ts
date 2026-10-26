/**
 * Teams into the store's rows: the aggregator's chats and channels as rooms
 * and read states, the chat service's messages (HTML) as the markdown the
 * renderer reads, emotions as reactions. Mirrors
 * `crates/rv-teams/src/translate.rs`.
 */

import type { LocalMessage, LocalRoom, LocalSubscription } from '@rocket-vibe/provider-api/rows';
import type { MemberPage, RoomMember } from '@rocket-vibe/provider-api/provider';

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

/** A message's text, under the post's subject in bold when it has one. */
export function bodyText(raw: unknown): string {
  const content = str(raw, 'content') ?? '';
  const html = (str(raw, 'messagetype') ?? '').startsWith('RichText') || (str(raw, 'contenttype') ?? '').toLowerCase() === 'html';
  const body = html ? htmlToMarkdown(content) : decodeEntities(content).trim();
  const title = subject(raw);
  return title === null ? body : body === '' ? `**${title}**` : `**${title}**\n\n${body}`;
}

/** A channel post's subject, the title Teams shows above it: the chat
 *  service's `properties.subject`, or `subject` where the aggregator or a
 *  rebuilt entry carries it. */
export function subject(raw: unknown): string | null {
  const title = str((raw as Doc | null | undefined)?.properties, 'subject') ?? str(raw, 'subject');
  const clean = title === null ? '' : decodeEntities(title).trim();
  return clean === '' ? null : clean;
}

/** An edited text without the subject `bodyText` put in front of it: the
 *  subject stays the message's own property. */
export function withoutSubject(raw: unknown, text: string): string {
  const title = subject(raw);
  const head = title === null ? null : `**${title}**`;
  return head !== null && text.startsWith(head) ? text.slice(head.length).replace(/^\n+/, '') : text;
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

/** An image on Teams' object store (`https://<region>.asyncgw.teams.microsoft.com/v1/objects/<id>/views/<view>`),
 *  read with the skype token (verified live 2026-10-24). Mirrors `is_teams_image` in the desktop core. */
export function isTeamsImage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === ''
      && u.hostname.toLowerCase().endsWith('.asyncgw.teams.microsoft.com')
      && u.pathname.startsWith('/v1/objects/') && u.pathname.includes('/views/');
  } catch {
    return false;
  }
}

function imageAttachment(url: string, title: string | null, width: number | null, height: number | null): Doc {
  const a: Doc = { image_url: url };
  if (title) a.title = title;
  if (width && height && width > 0 && height > 0) a.image_dimensions = { width, height };
  return a;
}

/** The images pasted into a message: its `<img>` tags on Teams' object store, emoji left to the text. */
function inlineImages(content: string): Doc[] {
  const out: Doc[] = [];
  for (const [tag] of content.matchAll(/<img\b[^>]*>/gi)) {
    if (/itemtype\s*=\s*["'][^"']*\/Emoji["']/i.test(tag)) continue;
    const attr = (name: string): string | null => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? null;
    const src = attr('src');
    if (!src) continue;
    const url = decodeEntities(src);
    if (!isTeamsImage(url)) continue;
    const size = (name: string): number | null => {
      const v = Number.parseInt(attr(name) ?? '', 10);
      return Number.isFinite(v) ? v : null;
    };
    out.push(imageAttachment(url, null, size('width'), size('height')));
  }
  return out;
}

/** A message's attachments in the renderer's RC shape: images pasted into it,
 *  then its `properties.files` (a JSON string), each with its preview image
 *  when Teams keeps one on its object store. Only SharePoint/OneDrive files
 *  become file cards (downloaded through Graph `/shares`). Mirrors
 *  `file_attachments` in the desktop core. */
export function fileAttachments(raw: unknown): string | null {
  const out: Doc[] = inlineImages(str(raw, 'content') ?? '');
  const props = (raw as Doc).properties as Doc | undefined;
  const files = props?.files;
  let parsed: unknown = files;
  if (typeof files === 'string') {
    try { parsed = JSON.parse(files); } catch { parsed = null; }
  }
  for (const f of Array.isArray(parsed) ? (parsed as Doc[]) : []) {
    const preview = f?.filePreview as Doc | undefined;
    const previewUrl = str(preview, 'previewUrl');
    if (previewUrl && isTeamsImage(previewUrl)) {
      out.push(imageAttachment(previewUrl, str(f, 'title') ?? str(f, 'fileName'), int(preview, 'previewWidth'), int(preview, 'previewHeight')));
    }
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
 * `crates/rv-teams/src/translate.rs`.
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
    callId: ended ? null : messageId(conversation, id),
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

/** A channel call's join page in Teams: the thread, the call's start message
 *  and its organizer, the starter. Mirrors `meetup_link` in the desktop core. */
export function meetupLink(thread: string, message: string, tenant: string, organizer: string): string {
  const context = new URLSearchParams({ context: JSON.stringify({ Tid: tenant, Oid: organizer }) });
  return `https://teams.microsoft.com/l/meetup-join/${thread.replaceAll(':', '%3a').replaceAll('@', '%40')}/${message}?${context}`;
}

/** The AAD object id of an `8:orgid:` MRI. */
export function objectId(mri: string): string | null {
  return mri.startsWith('8:orgid:') && mri.length > 8 ? mri.slice(8) : null;
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
  return { text: bodyText({ content: (last as Doc).content, messagetype: kind, subject: subject(last) }), author: from ? directory.shown(mriOf(from)) : null, at };
}

function lastAt(entry: unknown): number | null {
  const last = (entry as Doc)?.lastMessage;
  return last ? (instant(last, 'composeTime') ?? int(last, 'id')) : null;
}

/** The server id of the last message the aggregator carries for a chat or channel. */
export function lastId(entry: unknown): number | null {
  return int((entry as Doc)?.lastMessage, 'id');
}

/** The time of the last message that makes a room unread: membership, topic
 *  and control events are never stored, so they cannot be read past. */
function unreadAt(entry: unknown): number | null {
  const last = (entry as Doc)?.lastMessage;
  if (!last) return null;
  const kind = str(last, 'messageType') ?? '';
  if (kind.startsWith('ThreadActivity/') || kind.startsWith('Control/')) return null;
  return instant(last, 'composeTime') ?? int(last, 'id');
}

/** The entry read up to message `id`, as a mark read leaves it. */
export function readUpTo(entry: Doc, id: number): Doc {
  const seen = horizon(entry);
  if (seen !== null && seen >= id) return entry;
  const out: Doc = { ...entry, consumptionHorizon: { originalArrivalTime: id, timeStamp: Date.now() } };
  if ('isRead' in entry) out.isRead = true;
  if ('isMessageRead' in entry) out.isMessageRead = true;
  return out;
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

/** A channel's own name, "General" for a team's default one. */
export function channelName(channel: unknown): string {
  return str(channel, 'displayName') ?? 'General';
}

/** How a channel shows outside its team's section, where every team's
 *  default channel would otherwise read "General". */
export function qualifiedName(team: string, channel: string): string {
  return `${team} · ${channel}`;
}

/** An aggregator channel as a room, named after its team too: the team's own
 *  section shows the channel's name alone. */
export function channelRoom(channel: unknown, team: string | null, directory: TeamsDirectory): LocalRoom | null {
  const rid = str(channel, 'id');
  if (!rid) return null;
  const name = channelName(channel);
  const last = preview((channel as Doc).lastMessage, directory);
  const at = last?.at ?? lastAt(channel);
  const standard = (str(channel, 'channelType') ?? 'Standard') === 'Standard';
  return {
    rid,
    type: standard ? 'c' : 'p',
    name,
    displayName: team === null ? name : qualifiedName(team, name),
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

/** A chat's or channel's read state. Teams gives no count: an unread room
 *  counts one. A channel with no read horizon is one never opened or hidden,
 *  which Teams shows as read. A channel's `isFavorite` is Teams' older "shown
 *  in the team list" (every team's General carries it): a pinned one is the
 *  favorite. */
export function toSubscription(rid: string, entry: unknown, me: string, team: { id: string; name: string } | null): LocalSubscription {
  const doc = entry as Doc;
  const flag = typeof doc.isRead === 'boolean' ? doc.isRead : typeof doc.isMessageRead === 'boolean' ? doc.isMessageRead : null;
  const from = str(doc.lastMessage, 'from');
  const mine = doc.isLastMessageFromMe === true || (from !== null && mriOf(from) === me);
  const last = unreadAt(entry), seen = horizon(entry);
  const newer = last !== null && (seen === null ? team === null : last > seen);
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
    favorite: team === null ? doc.isFavorite === true : doc.isPinned === true,
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
