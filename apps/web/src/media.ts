import { all, read, write } from "./store";
export interface Media {
  account: string;
  room?: string;
  path: string;
  blob: Blob;
  at: number;
}
export async function cached(
  account: string,
  path: string,
): Promise<Blob | undefined> {
  return (await read<Media>("media", account + ":" + path))?.blob;
}
export async function cacheMedia(
  account: string,
  path: string,
  blob: Blob,
  room?: string,
): Promise<void> {
  await write("media", account + ":" + path, {
    account,
    room,
    path,
    blob,
    at: Date.now(),
  } satisfies Media);
  const records = (await all<Media>("media"))
    .filter((item) => item.account === account)
    .sort((a, b) => a.at - b.at);
  let size = records.reduce((sum, item) => sum + item.blob.size, 0);
  for (const item of records) {
    if (size <= 250 * 1024 * 1024) break;
    await write("media", account + ":" + item.path);
    size -= item.blob.size;
  }
}
