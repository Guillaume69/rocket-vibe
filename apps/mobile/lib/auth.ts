/**
 * Rocket.Chat authentication, 2FA included.
 *
 * The 2FA mechanism is **generic and misnamed**: the `totp-required` error
 * covers `totp` as well as `email` and `password`. The method actually
 * expected is in `details.method`. We don't guess, we read.
 *
 * For the `password` method, the expected code is the **hex SHA-256 of the
 * password**, never the plain password. Checked against a real 8.5 server by
 * changing a privileged setting.
 *
 * Like `ClientRest`, this module does not import `react-native`: hashing is
 * injected (`expo-crypto` in the app, `node:crypto` in tests).
 */

import type { ProviderKind } from './provider.ts';
import { ClientRest, TwoFactorError, type TwoFactorCode } from './rest.ts';

export type Session = {
  baseUrl: string;
  authToken: string;
  userId: string;
  username: string;
  /** Server type: decides which driver to instantiate. Always `rocketchat` here. */
  genre: ProviderKind;
  /**
   * The server's `Site_Url`, read by the login probe. It is the ONLY URL the
   * server recognises at the head of a quote permalink (`lib/quote.ts`);
   * `baseUrl` may differ (proxy alias, IP, port, http/https: the emulator
   * bench case, `10.0.2.2:3300` vs `localhost:3300`). `null` for a session
   * older than the field or a missing setting: we then fall back on
   * `baseUrl`, the historical behaviour.
   */
  siteUrl: string | null;
};

/** Hex SHA-256, lowercase. */
export type Hasher = (text: string) => Promise<string>;

export type Credentials = {
  user: string;
  password: string;
};

type LoginResponse = {
  status?: string;
  data: {
    authToken: string;
    userId: string;
    me: { username: string };
  };
};

/**
 * Turns a code typed by the user into a code the server accepts.
 *
 * - `totp` and `email`: the code is sent as is.
 * - `password`: it is the password that must be hashed, not the typed code.
 */
export async function prepareTwoFactorCode(
  error: TwoFactorError,
  input: string,
  hash: Hasher,
): Promise<TwoFactorCode> {
  if (error.method === 'password') {
    return { method: 'password', code: await hash(input) };
  }
  return { method: error.method, code: input.trim() };
}

/**
 * Opens a session. Throws `TwoFactorError` if the server requires a second
 * factor: the caller shows the right UI for `error.method`, then calls
 * `logIn` again with the prepared code.
 */
export async function logIn(
  client: ClientRest,
  credentials: Credentials,
  twoFactor?: TwoFactorCode,
): Promise<Session> {
  const response = await client.post<LoginResponse>('login', {
    anonymous: true,
    twoFactor,
    body: { user: credentials.user, password: credentials.password },
  });
  return sessionFrom(client.baseUrl, response);
}

/**
 * Resumes a session from a stored token. The same token serves REST **and**
 * the WebSocket: the DDP spike checked it, `method login {resume}` accepts it
 * as is.
 */
export async function resumeSession(client: ClientRest, authToken: string): Promise<Session> {
  const response = await client.post<LoginResponse>('login', {
    anonymous: true,
    body: { resume: authToken },
  });
  return sessionFrom(client.baseUrl, response);
}

class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

/**
 * `ClientRest` treats a 200 with an empty body as success, which `/logout`
 * needs. A `/login` answering that way would give `response.data === undefined`
 * and a raw `TypeError`: so we guard before destructuring.
 */
function sessionFrom(baseUrl: string, response: LoginResponse | undefined): Session {
  const data = response?.data;
  if (!data?.authToken || !data.userId) {
    throw new LoginError('Invalid login response: neither token nor user id.');
  }
  return {
    baseUrl,
    authToken: data.authToken,
    userId: data.userId,
    username: data.me?.username ?? '',
    genre: 'rocketchat',
    // `/login` does not know `Site_Url`: the login screen fills it in from its
    // probe (`ServerProfile.siteUrl`) before persisting. The resume check
    // (`ui/session.tsx`) only reads `username` from this result; the persisted
    // `siteUrl` is never overwritten by this null.
    siteUrl: null,
  };
}

/**
 * Asks for a code to be sent by email. `codeGenerated: false` in the 2FA error
 * means no code has gone out yet: call this first.
 *
 * Takes only the identifier: requiring `Credentials` would mean keeping the
 * password in memory for nothing.
 */
export function requestEmailCode(client: ClientRest, emailOrName: string): Promise<void> {
  return client
    .post('users.2fa.sendEmailCode', { anonymous: true, body: { emailOrUsername: emailOrName } })
    .then(() => undefined);
}

/**
 * Logout is **best-effort**. An already expired token gets a 401, but the
 * user is in fact logged out: propagating the error would show a failure
 * while the local session is erased.
 */
/**
 * Returns **true if the server did close the session**, false if the call did
 * not go through. The caller uses it to queue the logout rather than lose it
 * (`lib/deferredLogout.ts`): offline, the token stays alive server-side, and
 * nobody knew.
 *
 * The failure is still NOT raised as an exception: the local state is logged
 * out whatever happens, and an unreachable server must not hold the user on a
 * screen they just left.
 */
export async function logOut(client: ClientRest): Promise<boolean> {
  try {
    await client.post('logout');
    return true;
  } catch {
    return false;
  } finally {
    client.auth = null;
  }
}

/** Applies the session to the client for subsequent calls. */
export function applySession(client: ClientRest, session: Session): void {
  client.auth = { authToken: session.authToken, userId: session.userId };
}
