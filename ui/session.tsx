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
import { ClientRest, ErreurRest } from '../lib/rest.ts';
import {
  effacerSession,
  enregistrerDernierServeur,
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
    // au prochain démarrage que sa session n'a jamais existé. Les deux
    // écritures sont indépendantes, donc en parallèle.
    await Promise.all([enregistrerSession(session), enregistrerDernierServeur(session.baseUrl)]);
    setEtat({ phase: 'connecte', session, client: clientPour(session) });
  }, []);

  const deconnecter = useCallback(async () => {
    if (etat.phase !== 'connecte') return;
    const { client, session } = etat;
    setEtat({ phase: 'deconnecte' });
    try {
      await Promise.all([seDeconnecter(client), effacerSession(session.baseUrl)]);
    } catch {
      // L'état local est déjà déconnecté ; rien d'utile à remonter.
    }
  }, [etat]);

  const valeur = useMemo(
    () => ({ etat, connecter, deconnecter }),
    [etat, connecter, deconnecter],
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
