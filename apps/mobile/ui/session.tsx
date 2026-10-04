/**
 * Cycle de vie de la session, exposé à tous les écrans.
 *
 * Au démarrage, la session stockée est reprise **avec optimisme** : on se
 * déclare connecté immédiatement, et la validation réseau court en arrière-plan.
 * Seul un 401 — le serveur a révoqué le jeton — déconnecte ; un serveur
 * injoignable n'est pas une raison de jeter une session, c'est le quotidien
 * d'un client mobile hors ligne.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { appliquerSession, reprendreSession, seDeconnecter, type Session } from '../lib/auth.ts';
import { terminerDeconnexions } from '../lib/deferredLogout.ts';
import { definirClientProfil } from '../lib/profilePreload.ts';
import { desenregistrerJeton } from '../lib/pushToken.ts';
import { ClientRest, estJetonRefuse } from '../lib/rest.ts';
import {
  ajouterDeconnexionEnSuspens,
  effacerClePriveeE2E,
  effacerSession,
  enregistrerDernierServeur,
  enregistrerServeurConnu,
  enregistrerSession,
  lireDernierServeur,
  lireJetonPushRetenu,
  lireSession,
  listerDeconnexionsEnSuspens,
  purgerCleE2EHeritee,
  purgerToutesClesE2EHeritees,
  retirerDeconnexionEnSuspens,
} from '../lib/sessionStore.ts';

export type EtatSession =
  | { phase: 'demarrage' }
  | { phase: 'deconnecte' }
  | { phase: 'connecte'; session: Session; client: ClientRest };

type ContexteSession = {
  etat: EtatSession;
  /** Persiste la session et bascule l'app en mode connecté. */
  connecter: (session: Session) => Promise<void>;
  /** Efface la session locale ; le logout serveur est best-effort. */
  deconnecter: () => Promise<void>;
  /**
   * Bascule vers un autre serveur connu SANS toucher aux sessions : chacune
   * vit sous sa propre clé. Rend true si une session y existait ; sinon,
   * l'état retombe sur « deconnecte » et l'écran de connexion se pré-remplit.
   */
  changerDeServeur: (baseUrl: string) => Promise<boolean>;
  /**
   * Met à jour les infos de profil PORTÉES par la session (le pseudo) après une
   * édition réussie, et re-persiste. Le pseudo de la session alimente Paramètres
   * (`@username`) et l'avatar de « Mon profil » : sans ce rafraîchissement, ils
   * garderaient l'ancien pseudo jusqu'à une déconnexion/reconnexion.
   */
  majProfilSession: (maj: { username?: string }) => Promise<void>;
};

const Contexte = createContext<ContexteSession | null>(null);

/**
 * Point de création UNIQUE des clients de la vie courante — les trois chemins
 * (démarrage, connexion, bascule de serveur) passent par ici. C'est ce qui
 * permet d'y brancher la révocation une seule fois et de couvrir tous les
 * appels de l'app, sans toucher un seul site d'appel.
 */
function clientPour(session: Session, surJetonRefuse: (jeton: string) => void): ClientRest {
  const client = new ClientRest(session.baseUrl);
  client.surJetonRefuse = surJetonRefuse;
  appliquerSession(client, session);
  return client;
}

/**
 * Tout ce qu'une session laisse au Keystore, effacé d'un bloc.
 *
 * Rangé ici plutôt qu'inline aux quatre sorties (déconnexion, révocation, et
 * les deux 401 de validation) parce qu'un oubli à l'une d'elles ne se voit
 * pas : la clé privée E2EE survivait à la déconnexion, et c'est un JWK RSA
 * **déchiffré**. Les trois effacements sont indépendants, donc en parallèle.
 */
async function effacerTraces(session: Session): Promise<void> {
  await Promise.all([
    effacerSession(session.baseUrl),
    effacerClePriveeE2E(session.baseUrl, session.userId),
    // L'entrée de l'ancien format, si le balayage de démarrage ne l'a pas
    // encore emportée : sans elle, cette fonction mentirait sur son contrat.
    purgerCleE2EHeritee(session.baseUrl),
  ]);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [etat, setEtat] = useState<EtatSession>({ phase: 'demarrage' });

  // Jeton de la session actuellement affichée. La validation de démarrage s'y
  // compare avant d'agir : sans cela, un 401 tardif sur un jeton déjà remplacé
  // (déconnexion puis reconnexion pendant que la requête volait) effacerait la
  // session toute neuve — même serveur, donc même clé de stockage.
  const jetonCourant = useRef<string | null>(null);
  useEffect(() => {
    jetonCourant.current = etat.phase === 'connecte' ? etat.session.authToken : null;
    // Le préchargement de fiche (`lib/profilePreload`) ouvre `/profile` depuis des
    // fonctions de rendu sans client sous la main : on lui pose le client actif.
    definirClientProfil(etat.phase === 'connecte' ? etat.client : null);
  }, [etat]);

  /**
   * Le serveur a refusé ce jeton EN COURS DE SESSION.
   *
   * Déclenché par `ClientRest.surJetonRefuse`, donc par n'importe quel appel de
   * la vie courante — rattrapage, `chat.syncMessages`, envoi, présence. Sans
   * lui, un jeton révoqué ailleurs (mot de passe changé, `Accounts_LoginExpiration`,
   * `logoutOtherClients`) laissait l'app tourner sur le cache de la veille avec
   * une barre de synchro qui bat : indiscernable d'une panne réseau, et sans
   * aucun chemin de sortie avant un redémarrage.
   *
   * Deux gardes, pas une : `estJetonRefuse` a déjà écarté tout ce qui n'est pas
   * une révocation (lib/rest.ts) ; ici on écarte le 401 **périmé**, celui qui
   * atterrit sur un jeton déjà remplacé — déconnexion puis reconnexion pendant
   * que la requête volait, même serveur donc même clé de stockage. Sans cette
   * comparaison, un 401 tardif effacerait une session toute neuve.
   *
   * Aucun `POST /logout` : le jeton est déjà mort côté serveur, l'appeler ne
   * ferait que reprendre un 401. On efface, et on rend l'écran de connexion.
   */
  const revoquer = useCallback((session: Session, jeton: string) => {
    if (jetonCourant.current !== jeton) return;
    void (async () => {
      // On REGARDE avant de détruire. `connecter()` persiste la session neuve
      // AVANT de basculer l'état, donc entre le drapeau lu ci-dessus et cette
      // ligne, une reconnexion a pu écrire un jeton tout neuf sous la même clé
      // — le stockage est indexé par serveur, pas par session. Effacer en
      // aveugle emporterait cette session-là, et l'app démarrerait déconnectée
      // alors qu'un compte valide venait d'être ouvert.
      const stockee = await lireSession(session.baseUrl);
      if (stockee !== null && stockee.authToken !== jeton) return;
      await effacerTraces(session);
      // Relu APRÈS l'attente, pour la même raison.
      if (jetonCourant.current === jeton) setEtat({ phase: 'deconnecte' });
    })();
  }, []);

  useEffect(() => {
    let abandonne = false;

    // Les déconnexions que le réseau avait interrompues. Indépendant de la
    // session qui démarre — on peut très bien reprendre une session sur un
    // serveur pendant qu'on solde une déconnexion sur un autre. Tir-et-oublie :
    // rien ici ne doit retenir l'écran.
    terminerDeconnexions(
      { lister: listerDeconnexionsEnSuspens, retirer: retirerDeconnexionEnSuspens },
      (entree) => {
        const c = new ClientRest(entree.baseUrl);
        c.identifiants = { authToken: entree.authToken, userId: entree.userId };
        return c;
      },
    ).catch(() => {});

    // Les clés privées E2EE de l'ANCIEN format, indexées par serveur seul. Ici
    // et pas dans `SynchroProvider` : celui-ci ne monte que sur session active,
    // donc il ne verrait jamais l'orpheline d'un serveur que l'utilisateur a
    // quitté — précisément le cas que la migration doit servir.
    purgerToutesClesE2EHeritees().catch(() => {});

    (async () => {
      const serveur = await lireDernierServeur();
      const session = serveur === null ? null : await lireSession(serveur);
      if (abandonne) return;
      if (session === null) {
        setEtat({ phase: 'deconnecte' });
        return;
      }

      const client = clientPour(session, (jeton) => revoquer(session, jeton));
      setEtat({ phase: 'connecte', session, client });

      // Validation en arrière-plan. Un jeton révoqué répond 401 : on efface.
      // Tout autre échec (réseau coupé, serveur en maintenance) laisse la
      // session en place — la resynchronisation s'en chargera.
      try {
        // La reprise renvoie le profil COURANT du serveur. Si le pseudo a changé
        // (renommage depuis un autre appareil, ou pendant que l'app était
        // fermée), on l'adopte — sinon l'ancienne valeur stockée resterait
        // affichée dans Paramètres jusqu'à une reconnexion. Le jeton et l'uid ne
        // bougent pas, donc le `client` reste valable tel quel.
        const frais = await reprendreSession(client, session.authToken);
        if (
          !abandonne &&
          jetonCourant.current === session.authToken &&
          frais.username !== '' &&
          frais.username !== session.username
        ) {
          const maj = { ...session, username: frais.username };
          await enregistrerSession(maj);
          if (!abandonne && jetonCourant.current === session.authToken) {
            setEtat({ phase: 'connecte', session: maj, client });
          }
        }
      } catch (e) {
        const perime = jetonCourant.current !== session.authToken;
        // `estJetonRefuse` et non un `statut === 401` nu : `reprendreSession`
        // part en `anonyme` (le jeton voyage dans le CORPS), donc le crochet
        // `surJetonRefuse` ne la couvre pas — cette validation garde sa propre
        // détection, et elle doit être la même. Un 401 de proxy en HTML tombait
        // ici en plein, et déconnectait une session valide.
        if (abandonne || perime || !estJetonRefuse(e)) return;
        // La clé privée E2EE part avec la session : rangée par (serveur,
        // compte), elle n'a plus de compte à qui appartenir.
        await effacerTraces(session);
        if (!abandonne && jetonCourant.current === session.authToken) {
          setEtat({ phase: 'deconnecte' });
        }
      }
    })().catch(() => {
      // `SecureStore` qui échoue au démarrage = pas de session lisible.
      if (!abandonne) setEtat({ phase: 'deconnecte' });
    });
    return () => {
      abandonne = true;
    };
    // `revoquer` est stable (useCallback sans dépendance) : le citer ne fait
    // pas rejouer cet effet, qui doit courir une fois et une seule.
  }, [revoquer]);

  const connecter = useCallback(async (session: Session) => {
    // Persister AVANT de basculer l'UI : si l'écriture échoue, l'utilisateur
    // reste sur l'écran de connexion avec une erreur, plutôt que de découvrir
    // au prochain démarrage que sa session n'a jamais existé. Les trois
    // écritures sont indépendantes, donc en parallèle.
    await Promise.all([
      enregistrerSession(session),
      enregistrerDernierServeur(session.baseUrl),
      enregistrerServeurConnu(session.baseUrl),
    ]);
    setEtat({
      phase: 'connecte',
      session,
      client: clientPour(session, (jeton) => revoquer(session, jeton)),
    });
  }, [revoquer]);

  const changerDeServeur = useCallback(async (baseUrl: string) => {
    // Lire AVANT d'écrire quoi que ce soit : s'il n'y a pas de session
    // là-bas, on ne bouge ni l'état ni le pointeur — déconnecter l'utilisateur
    // et déplacer le pointeur de reprise vers un serveur sans session ferait
    // démarrer l'app déconnectée alors qu'une session valide existe ailleurs.
    const session = await lireSession(baseUrl);
    if (session === null) return false;

    await enregistrerDernierServeur(baseUrl);
    const client = clientPour(session, (jeton) => revoquer(session, jeton));
    setEtat({ phase: 'connecte', session, client });

    // Même règle qu'au démarrage : validation en arrière-plan, seul un 401
    // (jeton révoqué) déconnecte — et seulement si cette session est encore
    // celle affichée.
    reprendreSession(client, session.authToken).catch(async (e: unknown) => {
      if (estJetonRefuse(e) && jetonCourant.current === session.authToken) {
        await effacerTraces(session);
        if (jetonCourant.current === session.authToken) setEtat({ phase: 'deconnecte' });
      }
    });
    return true;
  }, [revoquer]);

  const deconnecter = useCallback(async () => {
    if (etat.phase !== 'connecte') return;
    const { client, session } = etat;
    setEtat({ phase: 'deconnecte' });
    try {
      // Le jeton FCM vient du Keystore, où il a été retenu À SON ENREGISTREMENT
      // (`ui/sync.tsx`). Le redemander ici à `obtenirJetonFcm()` créait le
      // canal de notification et demandait la permission POST_NOTIFICATIONS :
      // se déconnecter pouvait faire surgir un prompt système. Et sur un
      // appareil sans Play Services, il ne rendait rien — donc aucun `DELETE`
      // n'était même tenté, alors que le jeton, lui, avait bien été enregistré.
      const jetonPush = await lireJetonPushRetenu().catch(() => null);

      // Dé-enregistrer le jeton push AVANT le logout : l'appel exige encore
      // l'authentification. Un 404 est un succès (`lib/pushToken.ts`).
      const pushRetire =
        jetonPush === null ? true : await desenregistrerJeton(client, jetonPush).then(() => true, () => false);
      const sessionFermee = await seDeconnecter(client);

      // Ce que le réseau n'a pas laissé aboutir se rejoue au prochain
      // démarrage. Sans cette file, un logout hors ligne laissait la session
      // ouverte côté serveur ET le jeton push enregistré : l'appareil
      // continuait de recevoir des « Nouveau message » fantômes pour un compte
      // dont il n'a plus rien, jusqu'à la désinstallation.
      if (!pushRetire || !sessionFermee) {
        await ajouterDeconnexionEnSuspens({
          baseUrl: session.baseUrl,
          userId: session.userId,
          authToken: session.authToken,
          jetonPush: pushRetire ? null : jetonPush,
        });
      }

      // La clé privée E2EE part AVEC la session. C'est le JWK RSA déchiffré :
      // la laisser derrière faisait que le geste le plus fort de l'app —
      // « Se déconnecter » — protégeait moins que le bouton « Verrouiller ».
      // EN DERNIER : la file ci-dessus a besoin du jeton, et `effacerTraces`
      // ne le lit pas mais l'ordre rend l'intention lisible.
      await effacerTraces(session);
    } catch {
      // L'état local est déjà déconnecté ; rien d'utile à remonter.
    }
  }, [etat]);

  const majProfilSession = useCallback(
    async (maj: { username?: string }) => {
      if (etat.phase !== 'connecte') return;
      const session = { ...etat.session, ...maj };
      // Persister AVANT de basculer l'UI, comme `connecter` : le client garde
      // ses identifiants (jeton + uid inchangés), seul le pseudo affiché change.
      await enregistrerSession(session);
      setEtat({ phase: 'connecte', session, client: etat.client });
    },
    [etat],
  );

  const valeur = useMemo(
    () => ({ etat, connecter, deconnecter, changerDeServeur, majProfilSession }),
    [etat, connecter, deconnecter, changerDeServeur, majProfilSession],
  );

  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useSession(): ContexteSession {
  const contexte = useContext(Contexte);
  if (contexte === null) {
    throw new Error('useSession appelé hors de <SessionProvider>.');
  }
  return contexte;
}
