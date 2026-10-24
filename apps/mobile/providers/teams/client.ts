/**
 * Calls to a tenant's Teams services, each with its own credential: the chat
 * service with the Skype token, the aggregator with its bearer. A refused
 * token is renewed once before the call fails; only then does a 401 end the
 * session. Mirrors `crates/rv-teams/src/client.rs`.
 */

import { TeamsError, type TeamsRoutes, type TeamsTokens } from './auth.ts';

type Doc = Record<string, unknown>;

/** A path under a base, its opaque segments (conversation ids) percent-encoded. */
export function serviceUrl(base: string, segments: readonly string[], query = ''): string {
  const path = segments.map((s) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@').replace(/%3B/gi, ';').replace(/%3D/gi, '=')).join('/');
  return `${base.replace(/\/+$/, '')}/${path}${query ? `?${query}` : ''}`;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url of a string's UTF-8 bytes, no padding (the Graph `/shares` `u!`
 *  encoding, matching the Rust side's URL_SAFE_NO_PAD). */
export function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6);
    for (let j = 0; j < chars; j++) out += BASE64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

export type Answer = { status: number; body: Doc };

/** A file stored in a channel's SharePoint folder, as the chat-service
 *  message's `properties.files` entry needs it. */
export type TeamsFileRef = { itemId: string; name: string; webUrl: string; site: string; unique: string };

export type TeamsClientOptions = { fetch?: typeof fetch; onRejected?: () => void; me?: string; isChat?: (rid: string) => boolean };

/** The OneDrive folder Teams keeps a chat's files in. */
const CHAT_FILES = 'Microsoft Teams Chat Files';

export class TeamsClient {
  readonly tokens: TeamsTokens;
  private readonly options: TeamsClientOptions;
  private readonly fetcher: typeof fetch;
  /** A channel's SharePoint files folder (Graph drive id, folder item id), cached per room. */
  private readonly drives = new Map<string, { drive: string; folder: string }>();

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

  /** Presence for a batch of people (UPS getpresence), AAD-bearer auth. */
  async getPresence(mris: string[]): Promise<Doc[]> {
    const { routes } = await this.tokens.chat();
    if (!routes.presence || mris.length === 0) return [];
    const bearer = await this.tokens.presence();
    const url = `${routes.presence}/v1/presence/getpresence/`;
    const answer = await this.send(url, ['authorization', `Bearer ${bearer}`], 'POST', mris.map((mri) => ({ mri })));
    const body = answer.body as unknown;
    if (Array.isArray(body)) return body as Doc[];
    const responses = (body as Doc).responses;
    return Array.isArray(responses) ? (responses as Doc[]) : [];
  }

  /** Sets my availability (UPS forceavailability), with the presence bearer. */
  async setPresence(availability: string): Promise<void> {
    const { routes } = await this.tokens.chat();
    if (!routes.presence) return;
    const bearer = await this.tokens.presence();
    const url = `${routes.presence}/v1/me/forceavailability/`;
    await this.send(url, ['authorization', `Bearer ${bearer}`], 'PUT', { availability });
  }

  /** Short profiles (name, title, avatar etag) by MRI, via the middle tier with
   *  the Spaces bearer. Best effort: returns [] when the route or token is absent. */
  async profiles(mris: string[]): Promise<Doc[]> {
    const { routes } = await this.tokens.chat();
    if (!routes.middleTier || mris.length === 0) return [];
    const bearer = await this.tokens.spaces();
    const url = `${routes.middleTier}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&canBeSmtpAddress=false&skypeTeamsInfo=true`;
    const answer = await this.send(url, ['authorization', `Bearer ${bearer}`], 'POST', mris);
    const body = answer.body as unknown;
    if (Array.isArray(body)) return body as Doc[];
    const value = (body as Doc).value;
    return Array.isArray(value) ? (value as Doc[]) : [];
  }

  /** The chat service's conversation document (topic, members), best effort. */
  async roomDocument(rid: string): Promise<Doc> {
    const url = await this.conversation(rid, [], 'view=msnp24Equivalent');
    return (await this.chat('GET', url)).body;
  }

  /** The room's roster, from the threads service (`GET /v1/threads/<rid>`). */
  async roster(rid: string): Promise<Doc> {
    const { routes } = await this.tokens.chat();
    const url = serviceUrl(`${routes.chat}/v1`, ['threads', rid], 'view=msnp24Equivalent&threadProperties=1');
    return (await this.chat('GET', url)).body;
  }

  /** Resolve a Teams shared file's SharePoint/OneDrive url to a directly
   *  fetchable, pre-signed url through Graph: `GET /shares/u!{base64url}/
   *  driveItem` carries `@microsoft.graph.downloadUrl`, which needs no auth.
   *  Returns the input url when the driveItem has no download url. */
  async downloadUrl(url: string): Promise<string> {
    const bearer = await this.tokens.graph();
    const enc = base64Url(url);
    const answer = await this.send(
      `https://graph.microsoft.com/v1.0/shares/u!${enc}/driveItem`,
      ['authorization', `Bearer ${bearer}`],
      'GET',
    );
    const resolved = (answer.body as Doc)['@microsoft.graph.downloadUrl'];
    return typeof resolved === 'string' && resolved !== '' ? resolved : url;
  }

  /** Message search through the Substrate query API, with its own bearer. */
  async search(text: string): Promise<Doc> {
    const bearer = await this.tokens.substrate();
    const cvid = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
    const body = {
      Cvid: cvid,
      Scenario: { Name: 'teamsmessages' },
      EntityRequests: [{ EntityType: 'Message', ContentSources: ['Teams'], Query: { QueryString: text }, Size: 50 }],
    };
    const answer = await this.send('https://substrate.office.com/search/api/v2/query', ['authorization', `Bearer ${bearer}`], 'POST', body);
    return answer.body;
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

  /** Pins or unpins a channel post through the CSA aggregator (its bearer).
   *  Channel-scoped: the post lives under its parent team. Mirrors
   *  `TeamsSync::set_pinned` on the desktop side. */
  async setPinned(team: string, channel: string, post: string, on: boolean): Promise<void> {
    const { routes } = await this.tokens.chat();
    const url = serviceUrl(routes.aggregator, ['api', 'v1', 'teams', team, 'channels', channel, 'posts', post, 'pin']);
    const method = on ? 'POST' : 'DELETE';
    try {
      await this.send(url, ['authorization', `Bearer ${await this.tokens.aggregator()}`], method);
    } catch (e) {
      if (!(e instanceof TeamsError) || e.status !== 401) throw e;
      this.tokens.forgetAggregator();
      try {
        await this.send(url, ['authorization', `Bearer ${await this.tokens.aggregator()}`], method);
      } catch (again) {
        this.rejected(again);
      }
    }
  }

  /** Renames a channel as Teams' web app does: its templates service under the
   *  fabric route, addressed by the team's Graph group and the channel's
   *  Substrate group. Mirrors `TeamsSync::rename` in the desktop core. */
  async rename(group: string, substrateGroup: string, tenant: string, name: string): Promise<void> {
    const { routes } = await this.tokens.chat();
    const base = `${routes.aggregator.replace('/api/csa/', '/fabric/')}/templates`;
    const url = serviceUrl(base, ['api', 'teams', group, 'channels', `OID:${substrateGroup}@${tenant}`], 'forceSync=false');
    const body = { displayName: name };
    try {
      await this.send(url, ['authorization', `Bearer ${await this.tokens.templates()}`], 'PATCH', body);
    } catch (e) {
      if (!(e instanceof TeamsError) || e.status !== 401) throw e;
      this.tokens.forgetTemplates();
      try {
        await this.send(url, ['authorization', `Bearer ${await this.tokens.templates()}`], 'PATCH', body);
      } catch (again) {
        this.rejected(again);
      }
    }
  }

  /** A Graph GET with the Graph bearer, as a document. */
  private async graph(url: string): Promise<Doc> {
    return (await this.send(url, ['authorization', `Bearer ${await this.tokens.graph()}`], 'GET')).body;
  }

  /** The Graph group id of the team a channel belongs to, by scanning my joined
   *  teams for the one whose channels include it. A chat has none. */
  async parentTeam(channel: string): Promise<string> {
    const teams = await this.graph('https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id');
    for (const team of Array.isArray(teams.value) ? (teams.value as Doc[]) : []) {
      const gid = typeof team.id === 'string' ? team.id : null;
      if (!gid) continue;
      const chans = await this.graph(`https://graph.microsoft.com/v1.0/teams/${gid}/channels?$select=id`);
      if ((Array.isArray(chans.value) ? (chans.value as Doc[]) : []).some((c) => c.id === channel)) return gid;
    }
    throw new TeamsError('team_not_found');
  }

  /** (Graph drive id, folder item id) of a channel's files folder, cached per room. */
  async channelDrive(rid: string): Promise<{ drive: string; folder: string }> {
    const hit = this.drives.get(rid);
    if (hit) return hit;
    if (this.options.isChat?.(rid)) {
      const pair = await this.chatFilesFolder();
      this.drives.set(rid, pair);
      return pair;
    }
    const gid = await this.parentTeam(rid);
    const ff = await this.graph(
      `https://graph.microsoft.com/v1.0/teams/${gid}/channels/${rid}/filesFolder?$select=id,parentReference`,
    );
    const parent = ff.parentReference as Doc | undefined;
    const drive = typeof parent?.driveId === 'string' ? parent.driveId : null;
    const folder = typeof ff.id === 'string' ? ff.id : null;
    if (!drive || !folder) throw new TeamsError('files_folder');
    const pair = { drive, folder };
    this.drives.set(rid, pair);
    return pair;
  }

  /** My OneDrive's `Microsoft Teams Chat Files` folder, where Teams' own
   *  clients keep a chat's files; made when it does not exist yet. */
  private async chatFilesFolder(): Promise<{ drive: string; folder: string }> {
    const pair = (d: Doc): { drive: string; folder: string } | null => {
      const drive = (d.parentReference as Doc | undefined)?.driveId;
      return typeof drive === 'string' && typeof d.id === 'string' ? { drive, folder: d.id } : null;
    };
    const path = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(CHAT_FILES)}?$select=id,parentReference`;
    const found = await this.graph(path).then(pair, () => null);
    if (found) return found;
    const header: [string, string] = ['authorization', `Bearer ${await this.tokens.graph()}`];
    const body = { name: CHAT_FILES, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' };
    const made = await this.send('https://graph.microsoft.com/v1.0/me/drive/root/children', header, 'POST', body)
      .then((a) => pair(a.body), (e: unknown) => (e instanceof TeamsError && e.status === 409 ? null : Promise.reject(e)));
    const result = made ?? pair(await this.graph(path));
    if (!result) throw new TeamsError('chat_files');
    return result;
  }

  /** Grants a chat's other members read on a file in my OneDrive, as Teams'
   *  clients do, without Microsoft's invitation mail (`driveItem/invite`,
   *  verified live 2026-10-24). Mirrors `TeamsSync::share_with_chat`. */
  private async shareWithChat(rid: string, drive: string, itemId: string): Promise<void> {
    const roster = await this.roster(rid);
    const recipients = (Array.isArray(roster.members) ? (roster.members as Doc[]) : [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((mri) => mri.startsWith('8:orgid:') && mri !== this.options.me)
      .map((mri) => ({ objectId: mri.slice('8:orgid:'.length) }));
    if (recipients.length === 0) return;
    const header: [string, string] = ['authorization', `Bearer ${await this.tokens.graph()}`];
    await this.send(`https://graph.microsoft.com/v1.0/drives/${drive}/items/${itemId}/invite`, header, 'POST', {
      requireSignIn: true, sendInvitation: false, roles: ['read'], recipients,
    });
  }

  /** The Graph `/content` upload url for a named file in a room's folder. */
  async contentUrl(rid: string, name: string): Promise<string> {
    const { drive, folder } = await this.channelDrive(rid);
    return `https://graph.microsoft.com/v1.0/drives/${drive}/items/${folder}:/${encodeURIComponent(name)}:/content`;
  }

  /** The uploaded file re-read for its SharePoint ids (the message payload needs them). */
  async fileRef(rid: string, name: string): Promise<TeamsFileRef> {
    const { drive, folder } = await this.channelDrive(rid);
    const item = await this.graph(
      `https://graph.microsoft.com/v1.0/drives/${drive}/items/${folder}:/${encodeURIComponent(name)}?$select=id,name,webUrl,sharepointIds`,
    );
    const sp = item.sharepointIds as Doc | undefined;
    const text = (o: Doc | undefined, k: string): string => (typeof o?.[k] === 'string' ? (o[k] as string) : '');
    if (this.options.isChat?.(rid) && text(item, 'id')) await this.shareWithChat(rid, drive, text(item, 'id'));
    return {
      itemId: text(item, 'id'),
      name: text(item, 'name') || name,
      webUrl: text(item, 'webUrl'),
      site: text(sp, 'siteUrl'),
      unique: text(sp, 'listItemUniqueId'),
    };
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
