export type SlackCall = { method: string; args: Record<string, string>; headers: Headers; init: RequestInit | undefined };
export type SlackAnswer = { status?: number; body?: unknown; headers?: Record<string, string> };

export const TOKEN = 'xoxc-000-synthetic';
export const COOKIE = 'xoxd-synthetic%2Bbytes%3D';
export const AUTH = { ok: true, team_id: 'T000', user_id: 'U000', team: 'Test', user: 'me', url: 'https://test.slack.com/' };

/** A Slack Web API in a function: `route` answers each method, every call is recorded. */
export function fakeSlack(route: (call: SlackCall) => SlackAnswer | undefined) {
  const calls: SlackCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: SlackCall = {
      method: url.pathname.replace(/^\/api\//, ''),
      args: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      headers: new Headers(init?.headers),
      init,
    };
    calls.push(call);
    const answer = route(call) ?? { body: { ok: false, error: 'unknown_method' } };
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

export const message = (ts: string, over: Record<string, unknown> = {}) => ({ type: 'message', ts, user: 'U001', text: `message ${ts}`, ...over });

/** `conversations.history` over a fixed list, with Slack's bounds: `latest`/`oldest` exclusive unless `inclusive`. */
export function historyOf(all: Record<string, unknown>[], args: Record<string, string>): Record<string, unknown> {
  const key = (ts: string) => BigInt(ts.replace('.', ''));
  const inclusive = args.inclusive === 'true';
  const latest = args.latest === undefined ? null : key(args.latest);
  const oldest = args.oldest === undefined ? null : key(args.oldest);
  const inRange = all
    .filter((m) => {
      const k = key(String(m.ts));
      return (latest === null || (inclusive ? k <= latest : k < latest)) && (oldest === null || (inclusive ? k >= oldest : k > oldest));
    })
    .sort((a, b) => (key(String(b.ts)) > key(String(a.ts)) ? 1 : -1));
  const limit = Number(args.limit ?? 100);
  const start = args.cursor === undefined ? 0 : Number(args.cursor);
  const page = inRange.slice(start, start + limit);
  const more = start + limit < inRange.length;
  return { ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? String(start + limit) : '' } };
}
