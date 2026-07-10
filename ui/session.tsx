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
import { obtenirJetonFcm } from '../lib/push.ts';
import { desenregistrerJeton } from '../lib/pushToken.ts';
import { ClientRest, ErreurRest } from '../lib/rest.ts';
import {
  effacerSession,
  enregistrerDernierServeur,
  enregistrerServeurConnu,
  enregistrerSession,
  lireDernierServeur,
  lireSession,
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
};

const Contexte = createContext<ContexteSession | null>(null);

function clientPour(session: Session): ClientRest {
  const client = new ClientRest(session.baseUrl);
  appliquerSession(client, session);
  return client;
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
  }, [etat]);

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const serveur = await lireDernierServeur();
      const session = serveur === null ? null : await lireSession(serveur);
      if (abandonne) return;
      if (session === null) {
        setEtat({ phase: 'deconnecte' });
        return;
      }

      const client = clientPour(session);
      setEtat({ phase: 'connecte', session, client });

      // Validation en arrière-plan. Un jeton révoqué répond 401 : on efface.
      // Tout autre échec (réseau coupé, serveur en maintenance) laisse la
      // session en place — la resynchronisation s'en chargera.
      try {
        await reprendreSession(client, session.authToken);
      } catch (e) {
        const perime = jetonCourant.current !== session.authToken;
        if (abandonne || perime || !(e instanceof ErreurRest) || e.statut !== 401) return;
        await effacerSession(session.baseUrl);
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
  }, []);

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
    setEtat({ phase: 'connecte', session, client: clientPour(session) });
  }, []);

  const changerDeServeur = useCallback(async (baseUrl: string) => {
    // Lire AVANT d'écrire quoi que ce soit : s'il n'y a pas de session
    // là-bas, on ne bouge ni l'état ni le pointeur — déconnecter l'utilisateur
    // et déplacer le pointeur de reprise vers un serveur sans session ferait
    // démarrer l'app déconnectée alors qu'une session valide existe ailleurs.
    const session = await lireSession(baseUrl);
    if (session === null) return false;

    await enregistrerDernierServeur(baseUrl);
    const client = clientPour(session);
    setEtat({ phase: 'connecte', session, client });

    // Même règle qu'au démarrage : validation en arrière-plan, seul un 401
    // (jeton révoqué) déconnecte — et seulement si cette session est encore
    // celle affichée.
    reprendreSession(client, session.authToken).catch(async (e: unknown) => {
      if (
        e instanceof ErreurRest &&
        e.statut === 401 &&
        jetonCourant.current === session.authToken
      ) {
        await effacerSession(session.baseUrl);
        if (jetonCourant.current === session.authToken) setEtat({ phase: 'deconnecte' });
      }
    });
    return true;
  }, []);

  const deconnecter = useCallback(async () => {
    if (etat.phase !== 'connecte') return;
    const { client, session } = etat;
    setEtat({ phase: 'deconnecte' });
    try {
      // Dé-enregistrer le jeton push AVANT le logout : l'appel exige encore
      // l'authentification. Best-effort — un appareil sans Play Services ou
      // hors ligne ne doit pas bloquer la déconnexion ; un 404 est un succès.
      try {
        const r = await obtenirJetonFcm();
        if (r.ok) await desenregistrerJeton(client, r.jeton);
      } catch {
        // Volontairement ignoré.
      }
      await Promise.all([seDeconnecter(client), effacerSession(session.baseUrl)]);
    } catch {
      // L'état local est déjà déconnecté ; rien d'utile à remonter.
    }
  }, [etat]);

  const valeur = useMemo(
    () => ({ etat, connecter, deconnecter, changerDeServeur }),
    [etat, connecter, deconnecter, changerDeServeur],
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
