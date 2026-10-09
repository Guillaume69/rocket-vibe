/** Session-mode read transport. Credentials never leave the fixed Slack API origin. */
export type SlackIdentity = { key: string; teamId: string; userId: string; team: string; user: string; origin: string };
export type SlackConversation = { id: string; name: string; kind: 'channel' | 'private' | 'direct' | 'group' };
export type SlackMessage = { ts: string; user: string; text: string; threadTs: string | null };
export type SlackPage<T> = { items: T[]; nextCursor: string | null };
type Method = 'auth.test' | 'users.conversations' | 'conversations.history';
const CODES = new Set(['invalid_auth','not_authed','token_expired','token_revoked','account_inactive','missing_scope','not_allowed_token_type','no_permission','channel_not_found','not_in_channel','org_login_required','ratelimited']);
export class SlackError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(code: string, status = 0, retryAfter: number | null = null) {
    super('Slack: ' + code); this.name = 'SlackError'; this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function validateCredentials(token: string, cookie: string): void {
  if (!/^xoxc-[A-Za-z0-9-]+$/.test(token) || token.length > 16384 || !cookie.startsWith('xoxd-') || cookie.length <= 5 || cookie.length > 16384 || /[^\x21-\x7e]|[;,"\\]/.test(cookie))
    throw new SlackError('invalid_credentials');
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SlackError('invalid_response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,12}\.\d{6}$/.test(value)) throw new SlackError('invalid_timestamp');
  return value;
}
export function compareTimestamp(a: string, b: string): number {
  const [as, af] = exactTimestamp(a).split('.'), [bs, bf] = exactTimestamp(b).split('.');
  const ai = BigInt(as), bi = BigInt(bs);
  return ai < bi ? -1 : ai > bi ? 1 : af < bf ? -1 : af > bf ? 1 : 0;
}
function cursor(body: Record<string, unknown>): string | null {
  if (body.response_metadata == null) return null;
  const next = record(body.response_metadata).next_cursor;
  if (next == null || next === '') return null;
  if (typeof next !== 'string' || next.length > 4096) throw new SlackError('invalid_response');
  return next;
}
/** Transient preview only. No database, vault, logout/revoke or write methods. */
export class SlackReader {
  #token: string;
  #cookie: string;
  #identity: SlackIdentity | null = null;
  #requests = new Set<AbortController>();
  #closed = false;
  private readonly fetcher: typeof fetch;
  constructor(token: string, cookie: string, fetcher: typeof fetch = fetch) {
    validateCredentials(token,cookie); this.#token = token; this.#cookie = cookie; this.fetcher = fetcher;
  }
  close(): void {
    this.#closed = true; this.#token = ''; this.#cookie = ''; this.#identity = null;
    for (const request of this.#requests) request.abort();
  }
  async #call(method: Method, args: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (this.#closed) throw new SlackError('cancelled');
    const controller = new AbortController(); this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetcher('https://slack.com/api/' + method, {
        method:'POST', redirect:'error', signal:controller.signal,
        headers:{Authorization:'Bearer ' + this.#token, Cookie:'d=' + this.#cookie, 'Content-Type':'application/x-www-form-urlencoded; charset=utf-8'},
        body:new URLSearchParams(args).toString(),
      });
      const retry = response.headers.get('retry-after');
      const retryAfter = retry !== null && /^\d+$/.test(retry) ? Number(retry) : null;
      if (response.status === 429) throw new SlackError('ratelimited',429,retryAfter);
      if (!response.ok) throw new SlackError('http_error',response.status);
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new SlackError('response_too_large');
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(raw)); } catch { throw new SlackError('invalid_response'); }
      if (body.ok === false) throw new SlackError(CODES.has(text(body.error)) ? text(body.error) : 'api_error',response.status,retryAfter);
      if (body.ok !== true) throw new SlackError('invalid_response');
      if (this.#closed) throw new SlackError('cancelled');
      return body;
    } catch (error) {
      if (error instanceof SlackError) throw error;
      throw new SlackError(this.#closed ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'connection_failed');
    } finally { clearTimeout(timer); this.#requests.delete(controller); }
  }
  async authenticate(): Promise<SlackIdentity> {
    const body = await this.#call('auth.test');
    const teamId = text(body.team_id), userId = text(body.user_id);
    let url: URL;
    try { url = new URL(text(body.url)); } catch { throw new SlackError('invalid_identity'); }
    if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[UW][A-Z0-9]+$/.test(userId) || url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/')
      throw new SlackError('invalid_identity');
    if (this.#identity && (this.#identity.teamId !== teamId || this.#identity.userId !== userId)) throw new SlackError('identity_changed');
    this.#identity = {key:'slack:' + teamId + ':' + userId,teamId,userId,team:text(body.team) || teamId,user:text(body.user) || userId,origin:url.origin};
    return this.#identity;
  }
  async conversations(next?: string): Promise<SlackPage<SlackConversation>> {
    if (!this.#identity) throw new SlackError('authentication_required');
    const body = await this.#call('users.conversations',{types:'public_channel,private_channel,im,mpim',exclude_archived:'true',limit:'100',...(next ? {cursor:next} : {})});
    if (!Array.isArray(body.channels)) throw new SlackError('invalid_response');
    const items = body.channels.map(value => {
      const r = record(value), id = text(r.id);
      if (!/^[CDG][A-Z0-9]+$/.test(id)) throw new SlackError('invalid_response');
      const kind = r.is_im === true ? 'direct' : r.is_mpim === true ? 'group' : r.is_private === true ? 'private' : 'channel';
      return {id, name:text(r.name) || text(r.user) || id, kind} as SlackConversation;
    });
    return {items,nextCursor:cursor(body)};
  }
  async history(channel: string, next?: string): Promise<SlackPage<SlackMessage>> {
    if (!this.#identity) throw new SlackError('authentication_required');
    if (!/^[CDG][A-Z0-9]+$/.test(channel)) throw new SlackError('invalid_channel');
    const body = await this.#call('conversations.history',{channel,limit:'50',...(next ? {cursor:next} : {})});
    if (!Array.isArray(body.messages)) throw new SlackError('invalid_response');
    const items = body.messages.map(value => {
      const m = record(value);
      return {ts:exactTimestamp(m.ts), user:text(m.user) || text(m.bot_id), text:text(m.text), threadTs:m.thread_ts == null ? null : exactTimestamp(m.thread_ts)};
    }).sort((a,b) => compareTimestamp(b.ts,a.ts));
    const nextCursor = cursor(body);
    if (body.has_more === true && !nextCursor) throw new SlackError('pagination_unsupported');
    return {items,nextCursor};
  }
}
