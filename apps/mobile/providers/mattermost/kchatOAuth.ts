/**
 * Infomaniak sign-in for kChat: authorization code + PKCE (S256) against
 * `login.infomaniak.com`, with the client id and redirect of Infomaniak's own
 * kChat mobile app (`Infomaniak/mobile-kchat`, `app/init/ikauth.ts`). No scope
 * is sent and no `access_type=offline` is asked: the resulting access token
 * does not expire and no refresh token comes back, which is what the official
 * app relies on. The redirect scheme is declared in `app.json`, so the system
 * browser hands the code back to this app.
 */

export const KCHAT_CLIENT_ID = '20af5539-a4fb-421c-b45a-f43af3d90c14';
export const KCHAT_REDIRECT = 'com.infomaniak.chat://oauth2redirect';
const LOGIN = 'https://login.infomaniak.com';

export type Pkce = { verifier: string; challenge: string; state: string };

export class KchatOAuthError extends Error {}

/** `bytes` and `sha256` are injected: `expo-crypto` in the app, `node:crypto` under tests. */
export async function createPkce(
  randomBytes: (size: number) => Uint8Array,
  sha256: (data: string) => Promise<Uint8Array>,
): Promise<Pkce> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(await sha256(verifier));
  return { verifier, challenge, state: base64Url(randomBytes(16)) };
}

export function authorizeUrl(pkce: Pkce): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: KCHAT_CLIENT_ID,
    redirect_uri: KCHAT_REDIRECT,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    hide_create_account: '',
    prompt: 'login',
  });
  return `${LOGIN}/authorize?${query.toString()}`;
}

/** The code carried by the redirect, after checking it answers OUR request. */
export function codeFromRedirect(url: string, pkce: Pkce): string {
  if (!url.startsWith(KCHAT_REDIRECT)) throw new KchatOAuthError('Not the kChat redirect.');
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const error = query.get('error');
  if (error !== null) throw new KchatOAuthError(query.get('error_description') ?? error);
  if (query.get('state') !== pkce.state) throw new KchatOAuthError('Sign-in answer for another request.');
  const code = query.get('code');
  if (code === null || code === '') throw new KchatOAuthError('Sign-in answer without a code.');
  return code;
}

export async function exchangeCode(code: string, pkce: Pkce, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${LOGIN}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce.verifier,
      client_id: KCHAT_CLIENT_ID,
      redirect_uri: KCHAT_REDIRECT,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error_description?: unknown; error?: unknown };
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new KchatOAuthError(String(body.error_description ?? body.error ?? `HTTP ${response.status}`));
  }
  return body.access_token;
}

export function isKchatRedirect(path: string | null): boolean {
  return path !== null && path.startsWith('com.infomaniak.chat:');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}
