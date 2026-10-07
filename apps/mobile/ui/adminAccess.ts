/**
 * Who sees the server administration: the current provider must offer it
 * (`capabilities.administration`, `Provider.admin`) AND this account must be
 * an administrator (`ProviderAdmin.isAdmin`: Rocket.Chat `me.roles`, native
 * `/me/permissions`). The verdict is asked once per provider and session
 * generation, shared by every entry point (settings list, server rail, the
 * admin screens); a failure is not kept, the next visit asks again.
 *
 * Keyed by the provider's own object: an account switch builds a new one,
 * so one account's verdict never shows another account the admin screens.
 */

import { useEffect, useState } from 'react';

import { verdictCache, type ProviderAdmin } from '../lib/admin.ts';
import { useSync } from './sync.tsx';

const verdict = verdictCache();

/**
 * The administration of the current server: the `ProviderAdmin` when this
 * account administers it, `'no'` when it does not (or the server offers no
 * administration), `'unknown'` while asking.
 */
export function useAdminVerdict(): ProviderAdmin | 'no' | 'unknown' {
  const sync = useSync();
  const admin =
    sync.phase === 'ready' && sync.capabilities.administration === true ? (sync.provider.admin ?? null) : null;
  const generation = sync.phase === 'ready' ? sync.generation : 0;
  const [answer, setAnswer] = useState<{ admin: ProviderAdmin; ok: boolean } | null>(null);
  useEffect(() => {
    if (admin === null) return;
    let alive = true;
    verdict(admin, generation).then(
      (ok) => {
        if (alive) setAnswer({ admin, ok });
      },
      () => {
        if (alive) setAnswer({ admin, ok: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [admin, generation]);
  if (sync.phase !== 'ready') return 'unknown';
  if (admin === null) return 'no';
  if (answer === null || answer.admin !== admin) return 'unknown';
  return answer.ok ? admin : 'no';
}

/** The administration of the current server, or `null` when this account cannot (or not yet known to) administer it. */
export function useServerAdmin(): ProviderAdmin | null {
  const v = useAdminVerdict();
  return typeof v === 'string' ? null : v;
}
