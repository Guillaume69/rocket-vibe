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

type LecteurRest = Pick<ClientRest, 'get'>;

const chaines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function readPermissionSources(client: LecteurRest): Promise<SourcesPermissions> {
  const [liste, moi] = await Promise.all([
    client.get<{ update?: { _id?: unknown; roles?: unknown }[] }>('permissions.listAll'),
    client.get<{ roles?: unknown }>('me'),
  ]);
  const roles = new Map<string, string[]>();
  for (const p of liste.update ?? []) {
    if (typeof p._id === 'string') roles.set(p._id, chaines(p.roles));
  }
  return { roles, globalRoles: chaines(moi.roles) };
}

/** La colonne `abonnements.roles` → liste ; illisible ou absente = aucun rôle. */
export function roomRoles(roles: string | null | undefined): string[] {
  if (roles == null) return [];
  try {
    return chaines(JSON.parse(roles));
  } catch {
    return [];
  }
}

export function grantedPermissions(sources: SourcesPermissions, rolesSalon: string[]): string[] {
  const miens = new Set([...sources.globalRoles, ...rolesSalon]);
  const accordees: string[] = [];
  for (const [permission, roles] of sources.roles) {
    if (roles.some((r) => miens.has(r))) accordees.push(permission);
  }
  return accordees;
}

const enCache = new Map<string, Promise<SourcesPermissions>>();

export function sourcesPermissions(
  client: LecteurRest & Pick<ClientRest, 'baseUrl' | 'auth'>,
): Promise<SourcesPermissions> {
  const cle = `${client.baseUrl}|${client.auth?.userId ?? ''}`;
  const connue = enCache.get(cle);
  if (connue !== undefined) return connue;
  const lecture = readPermissionSources(client);
  enCache.set(cle, lecture);
  lecture.catch(() => enCache.delete(cle));
  return lecture;
}
