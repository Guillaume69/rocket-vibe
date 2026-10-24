import { broken, check, ok, pick, request, source } from './lib.mjs';

const AUTH = 'crates/rv-teams/src/auth.rs';
const FIELDS = ['user_code', 'device_code', 'verification_uri', 'expires_in', 'interval'];

/** Every resource the apps mint a token for: the `https://` constants of auth.rs that are not plain hosts we call. */
export function audiences(text) {
  const names = ['SPACES', 'AGGREGATOR', 'PRESENCE_SCOPE', 'SUBSTRATE', 'TEMPLATES', 'GRAPH'];
  return names.map((name) => {
    const match = new RegExp(`const ${name}: &str = "(https://[^"]+)"`).exec(text);
    if (!match) throw new Error(`cannot read ${name} from ${AUTH}`);
    return match[1];
  });
}

export async function teams() {
  const client = pick(AUTH, /pub const CLIENT_ID: &str = "([^"]+)"/, 'the Teams client id');
  const login = pick(AUTH, /pub const LOGIN: &str = "([^"]+)"/, 'the sign-in host');
  const authz = pick(AUTH, /pub const AUTHZ: &str = "([^"]+)"/, 'the authz URL');
  const deviceUrl = `${login}/organizations/oauth2/v2.0/devicecode`;
  const tokenUrl = `${login}/organizations/oauth2/v2.0/token`;
  const results = [];

  results.push(await check('teams.endpoints', async () => {
    const answer = await request(`${login}/organizations/v2.0/.well-known/openid-configuration`);
    const config = answer.json ?? {};
    if (config.device_authorization_endpoint !== deviceUrl || config.token_endpoint !== tokenUrl) {
      return broken('teams.endpoints', `Microsoft's sign-in configuration names ${config.device_authorization_endpoint} and ${config.token_endpoint}; the apps call ${deviceUrl} and ${tokenUrl}.`);
    }
    return ok('teams.endpoints', 'device-code and token endpoints unchanged');
  }));

  for (const audience of audiences(source(AUTH))) {
    const id = `teams.device-code ${new URL(audience).host}`;
    results.push(await check(id, async () => {
      const scope = `${audience}/.default openid profile offline_access`;
      const answer = await request(deviceUrl, { method: 'POST', body: new URLSearchParams({ client_id: client, scope }) });
      const body = answer.json ?? {};
      if (answer.status !== 200) return broken(id, `a device code for ${audience} with client ${client} answered ${answer.status} ${body.error ?? ''} ${(body.error_description ?? '').split('\r\n')[0]}`.trim());
      const missing = FIELDS.filter((field) => body[field] === undefined);
      if (missing.length > 0 || !String(body.verification_uri).startsWith('https://')) return broken(id, `the device-code answer lacks ${missing.join(', ') || 'an https verification_uri'}`);
      return ok(id, 'device code issued');
    }));
  }

  results.push(await check('teams.token', async () => {
    const answer = await request(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ client_id: client, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'canary' }),
    });
    const error = answer.json?.error;
    if (answer.status !== 400 || error !== 'invalid_grant') {
      return broken('teams.token', `polling a bogus device code answered ${answer.status} ${error ?? ''} (${(answer.json?.error_codes ?? []).join(', ')}), not 400 invalid_grant: the client may no longer be allowed the device-code grant.`);
    }
    return ok('teams.token', 'the device-code grant still answers the client');
  }));

  results.push(await check('teams.authz', async () => {
    const answer = await request(authz, { method: 'POST' });
    if (answer.status !== 401) return broken('teams.authz', `${authz} answered ${answer.status} without a token, not 401: the skype token exchange moved or is gone.`);
    return ok('teams.authz', 'authz asks for a token');
  }));

  return results;
}
