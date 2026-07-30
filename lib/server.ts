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

import { ClientRest, type Dependances, ErreurRest } from './rest.ts';

export type DeuxFacteurs = {
  actif: boolean;
  totp: boolean;
  email: boolean;
};

export type ProfilServeur = {
  /** L'URL normalisée par `normaliserUrl` : celle que le sondage a réellement
   * interrogée. L'appelant construit son client dessus, plutôt que de
   * re-normaliser la saisie de son côté et risquer de viser un autre hôte. */
  baseUrl: string;
  version: string;
  siteUrl: string | null;
  formulaireDeConnexion: boolean;
  deuxFacteurs: DeuxFacteurs;
  ldap: boolean;
  oauth: string[];
  e2eeActif: boolean;
  fichiersProteges: boolean;
  avatarsProteges: boolean;
};

/** Le champ `value` de `settings.public` est hétérogène : on ne le contraint pas. */
type ReglagePublic = { _id: string; value: unknown };

export class ErreurServeur extends Error {
  readonly origine?: unknown;

  constructor(message: string, origine?: unknown) {
    super(message);
    this.name = 'ErreurServeur';
    this.origine = origine;
  }
}

/**
 * Accepte « chat.example.com », « http://192.168.1.106:3000 » ou une URL avec
 * barre finale. Sans schéma, on suppose `https://`.
 *
 * Le **sous-chemin est conservé** : un Rocket.Chat servi derrière un reverse
 * proxy vit souvent sous `/chat`, et `new URL(…).origin` le supprimerait.
 */
export function normaliserUrl(entree: string): string {
  const brut = entree.trim();
  if (brut === '') throw new ErreurServeur('Adresse vide.');
  const avecSchema = /^https?:\/\//i.test(brut) ? brut : `https://${brut}`;
  let url: URL;
  try {
    url = new URL(avecSchema);
  } catch (e) {
    throw new ErreurServeur(`Adresse invalide : ${brut}`, e);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function indexerReglages(charge: unknown): Map<string, unknown> {
  const settings = (charge as { settings?: unknown } | null)?.settings;
  if (!Array.isArray(settings)) {
    throw new ErreurServeur('`settings.public` ne contient pas de tableau `settings`.');
  }
  const index = new Map<string, unknown>();
  for (const brut of settings as ReglagePublic[]) {
    if (typeof brut?._id === 'string') index.set(brut._id, brut.value);
  }
  return index;
}

const vraiSi = (v: unknown): boolean => v === true;

/**
 * `/api/info` vit hors de `/api/v1/`, d'où `horsApiV1` — mais il hérite ainsi
 * du délai maximal, du relais d'annulation, du rejeu sur 429 et du parsage
 * défensif. Non authentifié, il rend `{version: '8.5', success: true}` sur
 * 8.5.1 : la version MINEURE seulement, ce qui suffit à nos bascules.
 */
async function recupererVersion(
  client: ClientRest,
  signal?: AbortSignal,
): Promise<string> {
  const charge = await client.get<{ version?: unknown }>('api/info', {
    anonyme: true,
    horsApiV1: true,
    signal,
  });
  if (typeof charge.version !== 'string') {
    throw new ErreurServeur("La réponse ne ressemble pas à celle d'un Rocket.Chat.");
  }
  return charge.version;
}

export async function sonderServeur(
  entree: string,
  signal?: AbortSignal,
  /** Même seam que `ClientRest` : les tests éprouvent la borne sans dormir. */
  dep?: Partial<Dependances>,
): Promise<ProfilServeur> {
  const base = normaliserUrl(entree);
  const client = new ClientRest(base, dep);

  const controleur = new AbortController();
  const relayer = () => controleur.abort();
  signal?.addEventListener('abort', relayer);
  if (signal?.aborted) controleur.abort();

  try {
    // Les deux appels sont indépendants : les enchaîner doublerait la latence.
    // `count=0` désactive la pagination, sans quoi on n'obtient qu'une page.
    const pVersion = recupererVersion(client, controleur.signal);
    const pReglages = client.get<unknown>('settings.public', {
      params: { count: 0 },
      anonyme: true,
      signal: controleur.signal,
    });
    pVersion.catch(() => {});
    pReglages.catch(() => {});

    let version: string;
    let brutReglages: unknown;
    try {
      [version, brutReglages] = await Promise.all([pVersion, pReglages]);
    } catch (e) {
      controleur.abort(); // Ne pas laisser la requête sœur traîner.
      if (e instanceof ErreurServeur) throw e;
      if (e instanceof ErreurRest) throw new ErreurServeur(e.message, e);
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ErreurServeur('Serveur injoignable.', e);
    }

    const reglages = indexerReglages(brutReglages);

    const oauth = [...reglages.entries()]
      .filter(([cle, valeur]) => cle.startsWith('Accounts_OAuth_') && valeur === true)
      .map(([cle]) => cle.replace('Accounts_OAuth_', ''));

    const siteUrl = reglages.get('Site_Url');

    return {
      baseUrl: base,
      version,
      siteUrl: typeof siteUrl === 'string' ? siteUrl : null,
      formulaireDeConnexion: vraiSi(reglages.get('Accounts_ShowFormLogin')),
      deuxFacteurs: {
        actif: vraiSi(reglages.get('Accounts_TwoFactorAuthentication_Enabled')),
        totp: vraiSi(reglages.get('Accounts_TwoFactorAuthentication_By_TOTP_Enabled')),
        email: vraiSi(reglages.get('Accounts_TwoFactorAuthentication_By_Email_Enabled')),
      },
      ldap: vraiSi(reglages.get('LDAP_Enable')),
      oauth,
      e2eeActif: vraiSi(reglages.get('E2E_Enable')),
      fichiersProteges: vraiSi(reglages.get('FileUpload_ProtectFiles')),
      avatarsProteges: vraiSi(reglages.get('Accounts_AvatarBlockUnauthenticatedAccess')),
    };
  } finally {
    signal?.removeEventListener('abort', relayer);
  }
}
