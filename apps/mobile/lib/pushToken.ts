/**
 * Registering the FCM token with Rocket.Chat.
 *
 * Contract checked in the server code at tag 8.5.0
 * (`apps/meteor/app/api/server/v1/push.ts`), then against the Docker server:
 *
 * - `POST /api/v1/push.token`, body `{ type, value, appName }`, all three
 *   required, `additionalProperties: false`: send nothing more.
 * - `type` is `'gcm'` (historical naming; the value is indeed an FCM v1
 *   token), on iOS as on Android since both go through FCM. The server also
 *   accepts `'apn'`, which the app does not send.
 * - `appName` is a **free string** (`minLength: 1`); no required link to the
 *   applicationId.
 * - `DELETE /api/v1/push.token`, body `{ token }`. A replay answers **404**:
 *   an already missing token is a successful unregistration, not a failure,
 *   otherwise logout would break after a reinstall.
 *
 * The transport (headers, retry on 429, defensive JSON, 2FA) comes from
 * `RestClient`: it is not reimplemented here.
 */

import { RestClient, RestError } from './rest.ts';

export const APP_NAME = 'rocket-vibe';

export type TokenType = 'gcm' | 'apn';

export function registerToken(
  client: RestClient,
  token: string,
  type: TokenType,
): Promise<unknown> {
  return client.post('push.token', { body: { type, value: token, appName: APP_NAME } });
}

export async function unregisterToken(client: RestClient, token: string): Promise<void> {
  try {
    await client.delete('push.token', { body: { token } });
  } catch (e) {
    // Test the status, not the message text, which may be reworded.
    if (e instanceof RestError && e.status === 404) return;
    throw e;
  }
}
