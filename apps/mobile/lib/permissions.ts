/**
 * Permissions Rocket.Chat de l'utilisateur, calculées comme le serveur les
 * vérifie : une permission est accordée quand l'un des rôles qui la portent
 * (`permissions.listAll`) est l'un des miens — rôles globaux (`me.roles`) ou
 * rôles dans le salon (`subscription.roles`, en base).
 *
 * `permissions.listAll` pèse ~270 Ko (1 000 permissions, sondé sur 8.5) et
 * bouge rarement : lu une fois par session et par compte, avec `me`, puis
 * gardé en mémoire. Un échec n'est pas retenu — l'appel suivant retente.
 */

import type { ClientRest } from './rest.ts';

export type SourcesPermissions = {
  /** Permission → rôles qui l'accordent. */
  roles: Map<string, string[]>;
  globalRoles: string[];
};

type RestReader = Pick<ClientRest, 'get'>;

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

/** La colonne `abonnements.roles` → liste ; illisible ou absente = aucun rôle. */
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
  client: RestReader & Pick<ClientRest, 'baseUrl' | 'auth'>,
): Promise<SourcesPermissions> {
  const key = `${client.baseUrl}|${client.auth?.userId ?? ''}`;
  const known = cached.get(key);
  if (known !== undefined) return known;
  const request = readPermissionSources(client);
  cached.set(key, request);
  request.catch(() => cached.delete(key));
  return request;
}
