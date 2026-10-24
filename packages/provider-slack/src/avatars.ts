/**
 * Slack people's photos: public CDN URLs read from their profiles, by user id
 * and username, per workspace. Rows ask synchronously; an unknown person has
 * no photo until the directory meets them.
 */

const photos = new Map<string, string>();

function key(baseUrl: string, who: string): string {
  return `${baseUrl.replace(/\/+$/, '')}\n${who}`;
}

export function rememberSlackAvatar(baseUrl: string, id: string, username: string, url: string | null): void {
  for (const who of [id, `@${username}`]) {
    if (url === null) photos.delete(key(baseUrl, who));
    else photos.set(key(baseUrl, who), url);
  }
}

export function slackAvatar(baseUrl: string, target: { uid?: string | null; username?: string | null }): string | null {
  if (target.uid) {
    const byId = photos.get(key(baseUrl, target.uid));
    if (byId !== undefined) return byId;
  }
  return target.username ? (photos.get(key(baseUrl, `@${target.username}`)) ?? null) : null;
}
