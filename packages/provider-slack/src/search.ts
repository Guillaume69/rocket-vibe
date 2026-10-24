/** Searching one room's messages with Slack's own search, scoped by its `in:<#channel>` modifier. */

import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import type { SlackClient } from './client.ts';
import type { SlackHistory } from './history.ts';
import type { SlackTranslator } from './translator.ts';

type Doc = Record<string, unknown>;

const SEARCH_COUNT = 100;

export async function searchSlackMessages(
  options: { client: SlackClient; history: SlackHistory; translator: SlackTranslator },
  rid: string,
  text: string,
): Promise<LocalMessage[]> {
  const body = await options.client.call('search.messages', {
    query: `${text} in:<#${rid}>`,
    count: SEARCH_COUNT,
    sort: 'timestamp',
    sort_dir: 'desc',
  });
  const matches = (body.messages as Doc | undefined)?.matches;
  const inRoom = (Array.isArray(matches) ? (matches as Doc[]) : []).filter((m) => (m?.channel as Doc | undefined)?.id === rid);
  const messages = await options.history.prepare(rid, inRoom);
  return messages.map((m) => options.translator.toMessage(m)).filter((m): m is LocalMessage => m !== null);
}
