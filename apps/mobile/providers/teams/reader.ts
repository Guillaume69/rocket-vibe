/** Read transport seam for a future browser-session broker. Not exposed as an account. */
import { TeamsError, accountKey, discoverRoutes, snapshotUrl, historyUrl, validateBackwardLink, parseSnapshot, parseHistory, type TeamsAccount, type TeamsRoutes } from './protocol.ts';
export type TeamsSessionTokens = { spaces: string; aggregator: string; chat: string };
function token(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 65536 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value)) throw new TeamsError('invalid_credentials');
}
export class TeamsReader {
  #tokens: TeamsSessionTokens;
  private readonly expiresAt: number;
  #account: TeamsAccount;
  #routes: TeamsRoutes|null = null;
  #closed = false;
  #discoveryVersion = 0;
  #requests = new Set<AbortController>();
  private readonly fetcher: typeof fetch;
  constructor(account: TeamsAccount, tokens: TeamsSessionTokens, fetcher: typeof fetch = fetch, expiresAt = Infinity) {
    this.expiresAt = expiresAt;
    accountKey(account); for (const value of [tokens.spaces,tokens.aggregator,tokens.chat]) token(value);
    this.#account = {...account}; this.#tokens = {...tokens}; this.fetcher = fetcher;
  }
  close(): void {
    this.#closed = true; this.#tokens = {spaces:'',aggregator:'',chat:''}; this.#routes = null;
    for (const request of this.#requests) request.abort();
  }
  async #call(url: string, audience: keyof TeamsSessionTokens, method: 'GET'|'POST' = 'GET'): Promise<unknown> {
    if (this.#closed) throw new TeamsError('cancelled');
    if (this.expiresAt <= Date.now()+30000) throw new TeamsError('session_expired');
    const controller = new AbortController(); this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(),15000);
    try {
      const response = await this.fetcher(url,{method,redirect:'error',credentials:'omit',signal:controller.signal,headers:{Authorization:'Bearer ' + this.#tokens[audience],Accept:'application/json'},...(method === 'POST' ? {body:''} : {})});
      const retry = response.headers.get('retry-after'), retryAfter = retry !== null && /^\d{1,9}$/.test(retry) ? Number(retry) : null;
      if (response.status === 429) throw new TeamsError('ratelimited',429,retryAfter);
      if (!response.ok) throw new TeamsError(response.status === 401 ? 'audience_rejected' : response.status === 403 ? 'permission_denied' : 'http_error',response.status);
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new TeamsError('response_too_large');
      if (this.#closed) throw new TeamsError('cancelled');
      try { return JSON.parse(raw) as unknown; } catch { throw new TeamsError('invalid_response'); }
    } catch (e) {
      if (e instanceof TeamsError) throw e;
      throw new TeamsError(this.#closed ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'connection_failed');
    } finally { clearTimeout(timer); this.#requests.delete(controller); }
  }
  async discover(): Promise<void> {
    // Only replace the route snapshot after the complete response passes policy.
    const version = ++this.#discoveryVersion;
    const routes = discoverRoutes(await this.#call('https://teams.microsoft.com/api/authsvc/v1.0/authz','spaces','POST'));
    if (this.#closed) throw new TeamsError('cancelled');
    if (version !== this.#discoveryVersion) throw new TeamsError('superseded_discovery');
    this.#routes = routes;
  }
  #ready(): TeamsRoutes {
    if (this.#closed) throw new TeamsError('cancelled');
    if (!this.#routes) throw new TeamsError('discovery_required');
    return this.#routes;
  }
  async conversations() { return parseSnapshot(await this.#call(snapshotUrl(this.#ready()),'aggregator')); }
  async history(conversation: string, backwardLink?: string) {
    const routes = this.#ready();
    const url = backwardLink ? validateBackwardLink(backwardLink,routes,conversation) : historyUrl(routes,conversation);
    return parseHistory(await this.#call(url,'chat'),this.#account,routes,conversation);
  }
}
