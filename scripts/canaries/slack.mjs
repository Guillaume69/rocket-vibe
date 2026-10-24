import { broken, check, notice, ok, pick, request, source } from './lib.mjs';

const CLIENT = 'packages/provider-slack/src/client.ts';
const EMOJIS = 'packages/provider-slack/src/emojis.generated.ts';

/** The `SlackMethod` union: every Web API method the apps call. */
export function methods(text) {
  const union = /export type SlackMethod =([^;]+);/.exec(text);
  if (!union) throw new Error(`cannot read SlackMethod from ${CLIENT}`);
  const names = [...union[1].matchAll(/'([a-z]+\.[A-Za-z.]+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`SlackMethod in ${CLIENT} lists no method`);
  return names;
}

export async function slack() {
  const api = pick(CLIENT, /const API = '([^']+)'/, 'the Slack API origin');
  const results = [];
  for (const method of methods(source(CLIENT))) {
    const id = `slack.method ${method}`;
    results.push(await check(id, async () => {
      const answer = await request(`${api}${method}`, { method: 'POST' });
      const error = answer.json?.error;
      if (error === 'not_authed') return ok(id, 'exists, asks for a token');
      return broken(id, `${method} answered ${answer.status} ${error ?? answer.text.slice(0, 120)}, not not_authed${error === 'unknown_method' || error === 'method_deprecated' ? ': Slack retired it' : ''}.`);
    }));
  }
  results.push(await check('slack.emoji', async () => {
    const ours = pick(EMOJIS, /emoji-datasource ([\d.]+)/, 'the emoji-datasource version');
    const answer = await request('https://registry.npmjs.org/emoji-datasource/latest');
    const latest = answer.json?.version;
    if (!latest) return broken('slack.emoji', `npm answered ${answer.status} for emoji-datasource`);
    return latest === ours
      ? ok('slack.emoji', `emoji names from emoji-datasource ${ours}, the latest`)
      : notice('slack.emoji', `emoji-datasource ${latest} is out; the names are from ${ours} (node scripts/generate-slack-emojis.mjs)`);
  }));
  return results;
}
