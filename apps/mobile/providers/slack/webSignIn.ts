/**
 * Slack's sign-in in the app's sign-in web view, the desktops' way: the page
 * shows Slack's own pages, stops on the desktop handoff (`/ssb/`) or the web
 * client, and the session's `d` cookie is read from the web view's store. The
 * workspace's boot page, fetched with that cookie, carries its `xoxc` token,
 * which `auth.test` then proves. Mirrors `rv-core/src/slack/browser_login.rs`.
 */

import type { Session } from '../../lib/auth.ts';
import { loginSlack, type SlackLoginOptions } from './auth.ts';
import { SlackError } from './client.ts';

export const SLACK_WEB_START = 'https://slack.com/signin';
/** Whose cookies the session is read from: the `d` cookie is set on `.slack.com`. */
export const SLACK_WEB_COOKIES = 'https://slack.com';

/** Slack's own hosts, never a workspace. */
const INFRA_HOSTS = new Set(['app', 'api', 'a', 'edgeapi', 'files', 'downloads', 'www', 'my', 'status', 'slack', 'join', 'signin']);
const BOOT_PAGE_MAX = 4_000_000;

function slackHost(host: string): boolean {
  if (host === 'slack.com') return true;
  const label = host.endsWith('.slack.com') ? host.slice(0, -'.slack.com'.length) : null;
  return label !== null && /^[a-z0-9-]+$/.test(label);
}

function slackUrl(raw: string): URL | null {
  if (raw.includes('\\')) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return slackHost(url.hostname.toLowerCase()) ? url : null;
}

/** The pages the sign-in web view shows: Slack's own `https` pages. */
export function isSlackWebPage(raw: string): boolean {
  return slackUrl(raw) !== null;
}

/** Where it stops: the desktop handoff, or the web client loading instead. */
export function isSlackWebDone(raw: string): boolean {
  const url = slackUrl(raw);
  if (url === null) return false;
  const path = url.pathname;
  return path.startsWith('/ssb/') || ['/client', '/app'].some((p) => path === p || path.startsWith(`${p}/`));
}

/** A workspace host the handoff or the web client names, never Slack's own. */
export function workspaceHosts(hosts: readonly string[]): string[] {
  const found: string[] = [];
  for (const raw of hosts) {
    const host = raw.toLowerCase();
    const label = host.endsWith('.slack.com') ? host.slice(0, -'.slack.com'.length) : null;
    if (label !== null && slackHost(host) && !INFRA_HOSTS.has(label) && !found.includes(host)) found.push(host);
  }
  return found;
}

/** The session's `d` cookie among a `Cookie` header's pairs, when exactly one. */
export function sessionCookie(header: string): string | null {
  const values = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith('d='))
    .map((pair) => pair.slice(2))
    .filter((value) => value.startsWith('xoxd-') && !/[^\x21-\x7e]|[;,"\\]/.test(value));
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0]! : null;
}

/** The `xoxc` token a boot page carries, preferring the keyed one. */
export function scrapeToken(html: string): string | null {
  const keyed = /"api_token"\s*:\s*"(xoxc-[A-Za-z0-9-]+)"/.exec(html);
  if (keyed) return keyed[1]!;
  return /xoxc-[A-Za-z0-9-]+/.exec(html)?.[0] ?? null;
}

/** The workspace's boot page, fetched with the session cookie; Slack serves it with a 403, token and all. */
async function bootToken(host: string, cookie: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(`https://${host}/`, { headers: { Cookie: `d=${cookie}` } });
    if (response.url && slackUrl(response.url) === null) return null;
    const html = await response.text();
    return html.length > BOOT_PAGE_MAX ? null : scrapeToken(html);
  } catch {
    return null;
  }
}

/**
 * The signed-in workspaces a finished web sign-in reached: `reached` is the
 * page it stopped on, `cookies` the `Cookie` header its store sends Slack,
 * `hosts` any workspace hosts the page named. Each is proved by `auth.test`.
 */
export async function signInFromWeb(
  reached: string,
  cookies: string,
  hosts: readonly string[] = [],
  options: SlackLoginOptions = {},
): Promise<Session[]> {
  const cookie = sessionCookie(cookies);
  if (cookie === null) throw new SlackError('authentication_failed');
  const fetcher = options.fetch ?? fetch;
  const candidates = workspaceHosts([slackUrl(reached)?.hostname ?? '', ...hosts]).slice(0, 20);
  const sessions: Session[] = [];
  for (const host of candidates) {
    const token = await bootToken(host, cookie, fetcher);
    if (token === null) continue;
    try {
      const session = await loginSlack(token, cookie, null, options);
      if (!sessions.some((s) => s.slackTeamId === session.slackTeamId)) sessions.push(session);
    } catch {
      // Another host may still sign in; none at all is reported below.
    }
  }
  if (sessions.length === 0) throw new SlackError('authentication_failed');
  return sessions;
}

/** Run in the web client page: the workspace hosts its local config names, never its tokens. */
export const CLIENT_HOSTS_SCRIPT = `(function(){try{var c=JSON.parse(localStorage.getItem('localConfig_v2')||'{}');var h=Object.values(c.teams||{}).map(function(t){try{return new URL(t.url).hostname}catch(e){return null}}).filter(Boolean);window.ReactNativeWebView.postMessage(JSON.stringify({hosts:h}))}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({hosts:[]}))}})();true;`;
