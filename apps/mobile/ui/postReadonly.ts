/**
 * Whether I may still write in a read-only Rocket.Chat room: the server lets
 * the holders of `post-readonly` (owners and moderators by default) post
 * there, so the composer must not lock them out, an owner who just switched
 * the room to read-only included.
 */

import { eq } from 'drizzle-orm';
import { useEffect, useState } from 'react';
import type { LocalDatabase } from '../db/client.ts';
import { subscriptions } from '../db/schema.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import type { RestClient } from '../lib/rest.ts';
import { useCoalescedLiveQuery } from './liveQuery.ts';

export function useMayPostReadonly(base: LocalDatabase, client: RestClient, rid: string, readOnly: boolean): boolean {
  const { data: rows } = useCoalescedLiveQuery(
    base.select({ roles: subscriptions.roles }).from(subscriptions).where(eq(subscriptions.rid, rid)).limit(1),
    [rid],
  );
  const roles = rows?.[0]?.roles;
  const eligible = readOnly && client.kind === 'rocketchat';
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!eligible) return;
    let alive = true;
    sourcesPermissions(client).then(
      (sources) => {
        if (alive) setAllowed(grantedPermissions(sources, roomRoles(roles)).includes('post-readonly'));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, eligible, roles]);
  return eligible && allowed;
}
