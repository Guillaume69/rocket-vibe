/**
 * Sonde un serveur Rocket.Chat **sans authentification**.
 *
 * `GET /api/info` et `GET /api/v1/settings.public` sont ouverts et suffisent à
 * découvrir la version, les méthodes d'authentification activées et les
 * réglages qui changent le comportement du client. C'est ce que fera l'écran de
 * connexion avant d'afficher quoi que ce soit.
 */

export type DeuxFacteurs = {
  actif: boolean;
  totp: boolean;
  email: boolean;
};

export type ProfilServeur = {
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

const DELAI_MS = 8_000;

export class ErreurServeur extends Error {
  // Champ ordinaire plutôt que « parameter property » : cette dernière n'est pas
  // une syntaxe effaçable, et empêche de charger le module tel quel sous Node.
  readonly origine?: unknown;

  constructor(message: string, origine?: unknown) {
    super(message);
    this.name = 'ErreurServeur';
    this.origine = origine;
  }
}

/**
 * Accepte « chat.example.com », « http://192.168.1.106:3000 » ou une URL avec
 * barre finale. Sans schéma, on suppose `https://` : un serveur public est en
 * HTTPS, et le HTTP en clair n'est autorisé que dans le variant debug.
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

/**
 * `fetch` borné dans le temps et annulable.
 *
 * Une annulation demandée par l'appelant propage l'`AbortError` tel quel, pour
 * qu'il la distingue d'un vrai échec ; un dépassement de délai, lui, devient
 * une `ErreurServeur` lisible. `AbortSignal.timeout` n'est pas garanti sous
 * Hermes, d'où le `setTimeout`.
 */
async function recuperer(url: string, signalExterne?: AbortSignal): Promise<unknown> {
  const controleur = new AbortController();
  let expire = false;
  const minuterie = setTimeout(() => {
    expire = true;
    controleur.abort();
  }, DELAI_MS);
  const relayer = () => controleur.abort();
  signalExterne?.addEventListener('abort', relayer);

  try {
    const reponse = await fetch(url, { signal: controleur.signal });
    if (!reponse.ok) {
      throw new ErreurServeur(`${url} a répondu ${reponse.status}.`);
    }
    // On lit le texte avant de parser : un reverse proxy peut renvoyer une page
    // HTML avec un code 200, et « JSON invalide » n'est pas « injoignable ».
    const texte = await reponse.text();
    try {
      return JSON.parse(texte) as unknown;
    } catch (e) {
      throw new ErreurServeur(`${url} n'a pas renvoyé du JSON (${texte.length} octets).`, e);
    }
  } catch (e) {
    if (e instanceof ErreurServeur) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      if (expire) throw new ErreurServeur(`Pas de réponse en ${DELAI_MS / 1000} s.`, e);
      throw e; // Annulation volontaire : l'appelant sait quoi en faire.
    }
    throw new ErreurServeur('Serveur injoignable.', e);
  } finally {
    clearTimeout(minuterie);
    signalExterne?.removeEventListener('abort', relayer);
  }
}

function indexerReglages(charge: unknown): Map<string, unknown> {
  if (typeof charge !== 'object' || charge === null) {
    throw new ErreurServeur('`settings.public` a renvoyé une charge inattendue.');
  }
  const settings = (charge as { settings?: unknown }).settings;
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

export async function sonderServeur(entree: string, signal?: AbortSignal): Promise<ProfilServeur> {
  const base = normaliserUrl(entree);

  const controleur = new AbortController();
  const relayer = () => controleur.abort();
  signal?.addEventListener('abort', relayer);

  try {
    // `/api/info` et non `/api/v1/info` : le premier est ouvert, le second peut
    // exiger des droits d'administration pour une partie de sa réponse.
    // `count=0` désactive la pagination : sans lui on n'obtient qu'une page.
    // Les deux appels sont indépendants : les enchaîner doublerait la latence.
    const pInfo = recuperer(`${base}/api/info`, controleur.signal);
    const pReglages = recuperer(`${base}/api/v1/settings.public?count=0`, controleur.signal);
    // Marque les rejets comme gérés : `Promise.all` n'en remonte qu'un, et le
    // second produirait sinon un rejet non géré.
    pInfo.catch(() => {});
    pReglages.catch(() => {});

    let info: unknown;
    let brutReglages: unknown;
    try {
      [info, brutReglages] = await Promise.all([pInfo, pReglages]);
    } catch (e) {
      controleur.abort(); // Ne pas laisser la requête sœur traîner.
      throw e;
    }

    const version = (info as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') {
      throw new ErreurServeur("La réponse ne ressemble pas à celle d'un Rocket.Chat.");
    }

    const reglages = indexerReglages(brutReglages);

    const oauth = [...reglages.entries()]
      .filter(([cle, valeur]) => cle.startsWith('Accounts_OAuth_') && valeur === true)
      .map(([cle]) => cle.replace('Accounts_OAuth_', ''));

    const siteUrl = reglages.get('Site_Url');

    return {
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
