export { memoryStore } from '@rocket-vibe/provider-api/testing';

export type Call = { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> };
export type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A Mattermost server in a function: `route` answers each call, every call is recorded. */
export function fakeServer(route: (call: Call) => Answer | undefined, base = 'http://mm.test') {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v4/, ''), query: url.searchParams, body, headers };
    calls.push(call);
    const answer = route(call) ?? { status: 404, body: { id: 'api.context.404.app_error', message: 'Not found' } };
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetcher, calls, base };
}

export function postList(posts: Record<string, unknown>[]) {
  return { order: posts.map((p) => String(p.id)), posts: Object.fromEntries(posts.map((p) => [String(p.id), p])) };
}

export const post = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  channel_id: 'ch1',
  user_id: 'u-bob',
  message: `message ${id}`,
  create_at: 1000,
  update_at: 1000,
  edit_at: 0,
  delete_at: 0,
  root_id: '',
  type: '',
  props: {},
  metadata: {},
  is_pinned: false,
  ...over,
});
