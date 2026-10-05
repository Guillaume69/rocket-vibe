/**
 * Provider selection from the session's `kind`. A single driver today
 * (Rocket.Chat); `mattermost` is added here as one clause when its driver
 * exists. The exhaustive `switch` forces handling any new `ProviderKind`:
 * adding a member without a clause breaks compilation.
 *
 * Transitional note: `client` is a `RestClient` (RC). The Mattermost driver
 * will have its own REST client; client creation will go through the kind
 * in 4b.
 */

import type { Session } from '../lib/auth.ts';
import type { Provider } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import { createRcProvider } from './rocketchat/index.ts';
import { createRocketVibeProvider } from './rocketvibe/index.ts';
import type { NativeStore } from './rocketvibe/store.ts';

export function createProvider(
  session: Session,
  client: RestClient,
  generateId: () => string,
  nativeStore?: NativeStore,
  nativeOptions:Parameters<typeof createRocketVibeProvider>[4]={},
): Provider {
  switch (session.kind) {
    case 'rocketchat':
      return createRcProvider(session, client, generateId);
    case 'rocketvibe':
      if (!nativeStore) throw new Error('Native provider requires its account store');
      return createRocketVibeProvider(session,client,generateId,nativeStore,nativeOptions);
  }
}
