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

export function createProvider(
  session: Session,
  client: RestClient,
  generateId: () => string,
): Provider {
  switch (session.genre) {
    case 'rocketchat':
      return createRcProvider(session, client, generateId);
  }
}
