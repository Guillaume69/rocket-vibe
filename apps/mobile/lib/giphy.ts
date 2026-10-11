import type { RestClient } from './rest.ts';
export type GifPreview = { id: string; type: 'image'; value: string };
export function imageLink(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      value.length <= 2048 &&
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !!u.hostname &&
      !['rc_uid', 'rc_token', 'token', 'access_token'].some((k) => u.searchParams.has(k))
    );
  } catch {
    return false;
  }
}
export function previews(value: unknown): GifPreview[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as Record<string, unknown>).preview;
  if (!raw || typeof raw !== 'object') return [];
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).flatMap((x: unknown) => {
    if (!x || typeof x !== 'object') return [];
    const v = x as Record<string, unknown>;
    return typeof v.id === 'string' &&
      v.id.length <= 256 &&
      v.type === 'image' &&
      typeof v.value === 'string' &&
      imageLink(v.value)
      ? [{ id: v.id, type: 'image' as const, value: v.value }]
      : [];
  });
}
export async function searchGiphy(client: RestClient, room: string, query: string): Promise<GifPreview[]> {
  return previews(await client.get('commands.preview', { params: { command: 'giphy', roomId: room, params: query } }));
}
export async function sendGiphy(
  client: RestClient,
  room: string,
  query: string,
  item: GifPreview,
  triggerId: string,
  thread?: string,
): Promise<void> {
  if (!imageLink(item.value)) throw Error('Invalid image');
  await client.post('commands.preview', {
    body: {
      command: 'giphy',
      roomId: room,
      params: query,
      triggerId,
      previewItem: item,
      ...(thread ? { tmid: thread } : {}),
    },
  });
}
