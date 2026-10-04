/**
 * Sonde un serveur Rocket.Chat **sans authentification**.
 *
 * `GET /api/info` et `GET /api/v1/settings.public` sont ouverts et suffisent à
 * découvrir la version, les méthodes d'authentification activées et les
 * réglages qui changent le comportement du client. C'est ce que fera l'écran de
 * connexion avant d'afficher quoi que ce soit.
 *
 * Le transport vient de `ClientRest` (délai, annulation, JSON défensif, rejeu
 * sur 429) — **y compris `/api/info`**, qui ne vit pas sous `/api/v1/` et
 * passe donc par l'option `horsApiV1`. Il en était exclu, sur un `fetch` nu :
 * une requête restée pendante (reverse proxy, portail captif) laissait le
 * `Promise.all` ci-dessous pendre à vie, donc l'écran de connexion mort et
 * muet, son garde `enVol` armé pour toujours.
 */

import { ClientRest, type Dependencies, RestError } from './rest.ts';

export type TwoFactor = {
  active: boolean;
  totp: boolean;
  email: boolean;
};

export type ServerProfile = {
  /** L'URL normalisée par `normaliserUrl` : celle que le sondage a réellement
   * interrogée. L'appelant construit son client dessus, plutôt que de
   * re-normaliser la saisie de son côté et risquer de viser un autre hôte. */
  baseUrl: string;
  version: string;
  siteUrl: string | null;
  loginForm: boolean;
  twoFactor: TwoFactor;
  ldap: boolean;
  oauth: string[];
  e2eeEnabled: boolean;
  filesProtected: boolean;
  avatarsProtected: boolean;
};

/** Le champ `value` de `settings.public` est hétérogène : on ne le contraint pas. */
type PublicSetting = { _id: string; value: unknown };

export class ServerError extends Error {
  readonly origin?: unknown;

  constructor(message: string, origin?: unknown) {
    super(message);
    this.name = 'ErreurServeur';
    this.origin = origin;
  }
}

/**
 * Accepte « chat.example.com », « http://192.168.1.106:3000 » ou une URL avec
 * barre finale. Sans schéma, on suppose `https://`.
 *
 * Le **sous-chemin est conservé** : un Rocket.Chat servi derrière un reverse
 * proxy vit souvent sous `/chat`, et `new URL(…).origin` le supprimerait.
 */
export function normalizeUrl(entry: string): string {
  const raw = entry.trim();
  if (raw === '') throw new ServerError('Adresse vide.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (e) {
    throw new ServerError(`Adresse invalide : ${raw}`, e);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function indexSettings(payload: unknown): Map<string, unknown> {
  const settings = (payload as { settings?: unknown } | null)?.settings;
  if (!Array.isArray(settings)) {
    throw new ServerError('`settings.public` ne contient pas de tableau `settings`.');
  }
  const index = new Map<string, unknown>();
  for (const raw of settings as PublicSetting[]) {
    if (typeof raw?._id === 'string') index.set(raw._id, raw.value);
  }
  return index;
}

const trueIf = (v: unknown): boolean => v === true;

/**
 * `/api/info` vit hors de `/api/v1/`, d'où `horsApiV1` — mais il hérite ainsi
 * du délai maximal, du relais d'annulation, du rejeu sur 429 et du parsage
 * défensif. Non authentifié, il rend `{version: '8.5', success: true}` sur
 * 8.5.1 : la version MINEURE seulement, affichée à la connexion.
 */
async function fetchVersion(
  client: ClientRest,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await client.get<{ version?: unknown }>('api/info', {
    anonymous: true,
    outsideApiV1: true,
    signal,
  });
  if (typeof payload.version !== 'string') {
    throw new ServerError("La réponse ne ressemble pas à celle d'un Rocket.Chat.");
  }
  return payload.version;
}

export async function probeServer(
  entry: string,
  signal?: AbortSignal,
  /** Même seam que `ClientRest` : les tests éprouvent la borne sans dormir. */
  dep?: Partial<Dependencies>,
): Promise<ServerProfile> {
  const base = normalizeUrl(entry);
  const client = new ClientRest(base, dep);

  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);
  if (signal?.aborted) controller.abort();

  try {
    // Les deux appels sont indépendants : les enchaîner doublerait la latence.
    // `count=0` désactive la pagination, sans quoi on n'obtient qu'une page.
    const pVersion = fetchVersion(client, controller.signal);
    const settingsPromise = client.get<unknown>('settings.public', {
      params: { count: 0 },
      anonymous: true,
      signal: controller.signal,
    });
    pVersion.catch(() => {});
    settingsPromise.catch(() => {});

    let version: string;
    let rawSettings: unknown;
    try {
      [version, rawSettings] = await Promise.all([pVersion, settingsPromise]);
    } catch (e) {
      controller.abort(); // Ne pas laisser la requête sœur traîner.
      if (e instanceof ServerError) throw e;
      if (e instanceof RestError) throw new ServerError(e.message, e);
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ServerError('Serveur injoignable.', e);
    }

    const settings = indexSettings(rawSettings);

    const oauth = [...settings.entries()]
      .filter(([key, value]) => key.startsWith('Accounts_OAuth_') && value === true)
      .map(([key]) => key.replace('Accounts_OAuth_', ''));

    const siteUrl = settings.get('Site_Url');

    return {
      baseUrl: base,
      version,
      siteUrl: typeof siteUrl === 'string' ? siteUrl : null,
      loginForm: trueIf(settings.get('Accounts_ShowFormLogin')),
      twoFactor: {
        active: trueIf(settings.get('Accounts_TwoFactorAuthentication_Enabled')),
        totp: trueIf(settings.get('Accounts_TwoFactorAuthentication_By_TOTP_Enabled')),
        email: trueIf(settings.get('Accounts_TwoFactorAuthentication_By_Email_Enabled')),
      },
      ldap: trueIf(settings.get('LDAP_Enable')),
      oauth,
      e2eeEnabled: trueIf(settings.get('E2E_Enable')),
      filesProtected: trueIf(settings.get('FileUpload_ProtectFiles')),
      avatarsProtected: trueIf(settings.get('Accounts_AvatarBlockUnauthenticatedAccess')),
    };
  } finally {
    signal?.removeEventListener('abort', relay);
  }
}
