/**
 * The user's Rocket.Chat permissions, computed the way the server checks them:
 * a permission is granted when one of the roles carrying it
 * (`permissions.listAll`) is one of mine, global roles (`me.roles`) or roles in
 * the room (`subscription.roles`, in the database).
 *
 * `permissions.listAll` weighs ~270 KB (1,000 permissions, probed on 8.5) and
 * rarely changes: read once per session and account, with `me`, then kept in
 * memory. A failure is not cached; the next call retries.
 */

import type { RestClient } from './rest.ts';

export type SourcesPermissions = {
  /** Permission → roles granting it. */
  roles: Map<string, string[]>;
  globalRoles: string[];
};

type RestReader = Pick<RestClient, 'get'>;

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function readPermissionSources(client: RestReader): Promise<SourcesPermissions> {
  const [list, me] = await Promise.all([
    client.get<{ update?: { _id?: unknown; roles?: unknown }[] }>('permissions.listAll'),
    client.get<{ roles?: unknown }>('me'),
  ]);
  const roles = new Map<string, string[]>();
  for (const p of list.update ?? []) {
    if (typeof p._id === 'string') roles.set(p._id, asStrings(p.roles));
  }
  return { roles, globalRoles: asStrings(me.roles) };
}

/** The `subscriptions.roles` column → list; unreadable or missing = no role. */
export function roomRoles(roles: string | null | undefined): string[] {
  if (roles == null) return [];
  try {
    return asStrings(JSON.parse(roles));
  } catch {
    return [];
  }
}

export function grantedPermissions(sources: SourcesPermissions, roomRoleList: string[]): string[] {
  const mine = new Set([...sources.globalRoles, ...roomRoleList]);
  const granted: string[] = [];
  for (const [permission, roles] of sources.roles) {
    if (roles.some((r) => mine.has(r))) granted.push(permission);
  }
  return granted;
}

const cached = new Map<string, Promise<SourcesPermissions>>();

export function sourcesPermissions(
  client: RestReader & Pick<RestClient, 'baseUrl' | 'auth'>,
): Promise<SourcesPermissions> {
  const key = `${client.baseUrl}|${client.auth?.userId ?? ''}`;
  const known = cached.get(key);
  if (known !== undefined) return known;
  const request = readPermissionSources(client);
  cached.set(key, request);
  request.catch(() => cached.delete(key));
  return request;
}
