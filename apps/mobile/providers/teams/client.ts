/**
 * Calls to a tenant's Teams services, each with its own credential: the chat
 * service with the Skype token, the aggregator with its bearer. A refused
 * token is renewed once before the call fails; only then does a 401 end the
 * session. Mirrors `apps/desktop/crates/rv-core/src/teams/client.rs`.
 */

import { TeamsError, type TeamsRoutes, type TeamsTokens } from './auth.ts';

type Doc = Record<string, unknown>;

/** A path under a base, its opaque segments (conversation ids) percent-encoded. */
export function serviceUrl(base: string, segments: readonly string[], query = ''): string {
  const path = segments.map((s) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@').replace(/%3B/gi, ';').replace(/%3D/gi, '=')).join('/');
  return `${base.replace(/\/+$/, '')}/${path}${query ? `?${query}` : ''}`;
}

export type Answer = { status: number; body: Doc };

export type TeamsClientOptions = { fetch?: typeof fetch; onRejected?: () => void };

export class TeamsClient {
  readonly tokens: TeamsTokens;
  private readonly options: TeamsClientOptions;
  private readonly fetcher: typeof fetch;

  constructor(tokens: TeamsTokens, options: TeamsClientOptions = {}) {
    this.tokens = tokens;
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
  }

  routes(): Promise<TeamsRoutes> {
    return this.tokens.chat().then((c) => c.routes);
  }

  /** A conversation's URL under the chat service: `tail` after its id. */
  async conversation(rid: string, tail: readonly string[], query = ''): Promise<string> {
    const { routes } = await this.tokens.chat();
    return serviceUrl(`${routes.chat}/v1`, ['users', 'ME', 'conversations', rid, ...tail], query);
  }

  private async send(url: string, header: [string, string], method: string, body?: unknown): Promise<Answer> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: { [header[0]]: header[1], ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
      });
    } catch {
      throw new TeamsError('network');
    }
    const text = await response.text().catch(() => '');
    let parsed: Doc = {};
    try { parsed = text ? (JSON.parse(text) as Doc) : {}; } catch { parsed = {}; }
    if (response.status >= 400) {
      const retry = Number(response.headers.get('retry-after'));
      throw new TeamsError(`http_${response.status}`, response.status, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return { status: response.status, body: parsed };
  }

  private rejected(error: unknown): never {
    if (error instanceof TeamsError && error.status === 401) this.options.onRejected?.();
    throw error;
  }

  /** A chat service call. */
  async chat(method: string, url: string, body?: unknown): Promise<Answer> {
    try {
      const { skype } = await this.tokens.chat();
      return await this.send(url, ['authentication', `skypetoken=${skype}`], method, body);
    } catch (e) {
      if (!(e instanceof TeamsError) || e.status !== 401) throw e;
      this.tokens.forgetChat();
      try {
        const { skype } = await this.tokens.chat();
        return await this.send(url, ['authentication', `skypetoken=${skype}`], method, body);
      } catch (again) {
        return this.rejected(again);
      }
    }
  }

  /** The aggregator's list of chats and teams. */
  async snapshot(): Promise<Doc> {
    const { routes } = await this.tokens.chat();
    const url = serviceUrl(routes.aggregator, ['api', 'v2', 'teams', 'users', 'me'], 'isPrefetch=false&enableMembershipSummary=true');
    try {
      return (await this.send(url, ['authorization', `Bearer ${await this.tokens.aggregator()}`], 'GET')).body;
    } catch (e) {
      if (!(e instanceof TeamsError) || e.status !== 401) throw e;
      this.tokens.forgetAggregator();
      try {
        return (await this.send(url, ['authorization', `Bearer ${await this.tokens.aggregator()}`], 'GET')).body;
      } catch (again) {
        return this.rejected(again);
      }
    }
  }

  /** A backward link is followed only on the chat service's own host. */
  async trusted(link: unknown): Promise<string | null> {
    if (typeof link !== 'string') return null;
    const { routes } = await this.tokens.chat();
    let url: URL, base: URL;
    try { url = new URL(link); base = new URL(routes.chat); } catch { return null; }
    return url.protocol === base.protocol && url.host === base.host && url.pathname.startsWith(base.pathname) ? url.href : null;
  }
}
