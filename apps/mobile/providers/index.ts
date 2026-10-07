/**
 * Provider selection from the session's `kind`. The exhaustive `switch` forces
 * handling any new `ProviderKind`: adding a member without a clause breaks
 * compilation. `client` is the Rocket.Chat `RestClient`; the other drivers own
 * their transport and only borrow its token-rejection hook.
 */

import type { Session } from '../lib/auth.ts';
import type { Provider } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import { createMattermostProvider } from './mattermost/index.ts';
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
    case 'mattermost':
    case 'kchat':
      return createMattermostProvider(session, client, generateId);
  }
}
