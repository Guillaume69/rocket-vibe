/**
 * Messages épinglés et favoris (étoilés).
 *
 * `starred` arrive en `[{_id: uid}, …]` : on n'en garde que les uids, et
 * « étoilé par moi » se décide à la lecture, avec l'uid de la session — comme
 * les réactions, jugées au pseudo à l'affichage.
 *
 * `chat.pinMessage` ne diffuse PAS le message épinglé sur
 * `stream-room-messages` (sondé sur 8.5 : seul le message système
 * `message_pinned` arrive ; `unPin`, lui, diffuse). L'état local se pose donc
 * à la main après chaque geste réussi (`etoilesApres`, `Depot.majMarquesMessage`).
 */

/** `starred` brut → uids sérialisés, `null` si personne. */
export function starredIds(starred: unknown): string | null {
  if (!Array.isArray(starred)) return null;
  const ids: string[] = [];
  for (const e of starred) {
    const id = (e as { _id?: unknown } | null)?._id;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids.length === 0 ? null : JSON.stringify(ids);
}

function read(starred: string | null): string[] {
  if (starred === null) return [];
  try {
    const v: unknown = JSON.parse(starred);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function starredBy(starred: string | null, uid: string): boolean {
  return read(starred).includes(uid);
}

/** La colonne `etoiles` après que `uid` a (dés)étoilé le message. */
export function starredAfter(starred: string | null, uid: string, put: boolean): string | null {
  const others = read(starred).filter((x) => x !== uid);
  const ids = put ? [...others, uid] : others;
  return ids.length === 0 ? null : JSON.stringify(ids);
}
