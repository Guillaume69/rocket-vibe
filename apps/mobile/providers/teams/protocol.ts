/** Private Teams read contract. Candidate DTOs from the handoff, not Graph models. */
export class TeamsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(code: string, status = 0, retryAfter: number | null = null) {
    super('Teams: ' + code); this.name = 'TeamsError'; this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export type TeamsAccount = { tenantId: string; accountId: string };
export type TeamsRoutes = Readonly<{ aggregator: string; chat: string }>;
export type TeamsConversation = { id: string; name: string; kind: 'direct'|'group'|'meeting'|'channel'|'unsupported' };
export type TeamsMessage = { key: string; id: string; conversationId: string; rootId: string|null; version: string|null; author: string; arrivedAt: string; content: string; format: 'text'|'html'|'unsupported' };
export type TeamsHistory = { items: TeamsMessage[]; backwardLink: string|null };
export const TEAMS_CAPABILITIES = Object.freeze({ persistentAccounts:false, send:false, edit:false, delete:false, reactions:false, live:false, files:false, calls:false, push:false });
export function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamsError('invalid_response');
  return value as Record<string,unknown>;
}
export function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new TeamsError('invalid_identity');
  return value;
}
/** Input must come from a supported sign-in result/profile, never from an API JWT. */
export function accountKey(account: TeamsAccount): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.tenantId)) throw new TeamsError('invalid_identity');
  return JSON.stringify(['teams','global',account.tenantId.toLowerCase(),opaqueId(account.accountId)]);
}
function parseUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f\\]/.test(value)) throw new TeamsError('unsafe_route');
  let url: URL; try { url = new URL(value); } catch { throw new TeamsError('unsafe_route'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new TeamsError('unsafe_route');
  return url;
}
/** Conservative first policy: observed global-cloud Teams proxy aliases only. */
function route(value: unknown, service: 'aggregator'|'chat'): string {
  const url = parseUrl(value), segment = service === 'aggregator' ? 'csa' : 'chatsvc';
  if (url.origin !== 'https://teams.microsoft.com' || url.search || !new RegExp('^/api/' + segment + '/[A-Za-z0-9-]+/?$').test(url.pathname)) throw new TeamsError('unsafe_route');
  return url.origin + url.pathname.replace(/\/$/,'');
}
export function discoverRoutes(body: unknown): TeamsRoutes {
  const gtms = record(record(body).regionGtms);
  // Do not retain Skype tokens, other unqualified services or fallback fields.
  return Object.freeze({aggregator:route(gtms.chatSvcAggAfd,'aggregator'),chat:route(gtms.chatServiceAfd,'chat')});
}
export function snapshotUrl(routes: TeamsRoutes): string {
  return route(routes.aggregator,'aggregator') + '/api/v2/teams/users/me?isPrefetch=false&enableMembershipSummary=true';
}
export function historyUrl(routes: TeamsRoutes, conversation: string): string {
  return route(routes.chat,'chat') + '/v1/users/ME/conversations/' + encodeURIComponent(opaqueId(conversation)) + '/messages?pageSize=50';
}
export function validateBackwardLink(value: unknown, routes: TeamsRoutes, conversation: string): string {
  const url = parseUrl(value), expected = new URL(historyUrl(routes,conversation));
  const path = (u: URL) => { try { return JSON.stringify(u.pathname.split('/').map(part => decodeURIComponent(part))); } catch { throw new TeamsError('unsafe_pagination'); } };
  if (url.origin !== expected.origin || path(url) !== path(expected)) throw new TeamsError('unsafe_pagination');
  return url.href;
}
function optional(value: unknown, max = 65536): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new TeamsError('invalid_response');
  return value;
}
export function parseSnapshot(body: unknown): TeamsConversation[] {
  const b = record(body);
  if (!Array.isArray(b.chats) || !Array.isArray(b.teams) || b.chats.length > 10000 || b.teams.length > 1000) throw new TeamsError('invalid_response');
  const items: TeamsConversation[] = [], seen = new Set<string>();
  const add = (value: unknown, channel: boolean) => {
    const r = record(value), id = opaqueId(r.id), type = optional(r.chatType,128);
    const kind = channel ? 'channel' : type === 'oneOnOne' ? 'direct' : type === 'group' ? 'group' : type === 'meeting' ? 'meeting' : 'unsupported';
    if (!seen.has(id)) items.push({id,name:optional(r.title,4096) || optional(r.displayName,4096) || id,kind});
    seen.add(id);
  };
  for (const chat of b.chats) add(chat,false);
  for (const team of b.teams) {
    const channels = record(team).channels;
    if (!Array.isArray(channels) || channels.length > 10000 || items.length + channels.length > 20000) throw new TeamsError('invalid_response');
    for (const channel of channels) add(channel,true);
  }
  return items;
}
function validTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[5] ?? 0) > 23 || Number(match[6] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(match[1] + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === match[1];
}
export function parseHistory(body: unknown, account: TeamsAccount, routes: TeamsRoutes, conversation: string): TeamsHistory {
  const b = record(body), key = accountKey(account), context = opaqueId(conversation);
  if (!Array.isArray(b.messages) || b.messages.length > 1000) throw new TeamsError('invalid_response');
  const items = b.messages.map(value => {
    const r = record(value), id = opaqueId(r.id);
    const arrivedAt = optional(r.originalarrivaltime,64);
    if (!validTimestamp(arrivedAt)) throw new TeamsError('invalid_timestamp');
    const properties = r.properties == null ? {} : record(r.properties);
    const rootId = r.parentMessageId == null && properties.parentMessageId == null ? null : opaqueId(r.parentMessageId ?? properties.parentMessageId);
    const version = r.version == null ? null : opaqueId(r.version);
    const type = optional(r.messagetype,128), format = type === 'Text' ? 'text' : type === 'RichText/Html' ? 'html' : 'unsupported';
    return {key:JSON.stringify([key,context,rootId,id]),id,conversationId:context,rootId,version,author:optional(r.from,2048),arrivedAt,content:format === 'unsupported' ? '' : optional(r.content),format} satisfies TeamsMessage;
  });
  const metadata = b._metadata == null ? {} : record(b._metadata), next = metadata.backwardLink;
  return {items,backwardLink:next == null || next === '' ? null : validateBackwardLink(next,routes,context)};
}

/** No DOM, markup execution, remote images or link fetching. Limited plain-text preview. */
export function messageText(message: TeamsMessage): string {
  if (message.format !== 'html') return message.content;
  return message.content.replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'').replace(/<br\b[^>]*>|<\/(?:p|div|li)\s*>/gi,'\n').replace(/<[^>]*(?:>|$)/g,'')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#(?:039|39|x27);/gi,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
}
