/** Unlinking a WhatsApp account: WhatsApp forgets this device, then the state and its key go. */

import type { Session } from './auth.ts';
import { WhatsApp } from '../modules/whatsapp/index.ts';
import { whatsappState } from '@rocket-vibe/provider-whatsapp';

/** True once the link is gone, here and on WhatsApp's side; false keeps the account. */
export async function unlinkWhatsApp(session: Session): Promise<boolean> {
  const state = whatsappState(session.baseUrl);
  if (state === null || WhatsApp === null) return false;
  await WhatsApp.start(state);
  // The engine answers false once it logged out and ended; true means WhatsApp refused.
  if (await WhatsApp.handle(state, JSON.stringify({ type: 'logout' }))) return false;
  await WhatsApp.forget(state);
  return true;
}
