import type { ErreurFournisseur } from './fournisseur.ts';
import { ErreurRest, ErreurDeuxFacteurs, estJetonRefuse } from './rest.ts';
import { NativeError } from '../fournisseurs/rocketvibe/transport.ts';

export function decrireErreurFournisseur(erreur: unknown, authentifie: boolean): ErreurFournisseur {
  if (erreur instanceof NativeError) return {
    code:erreur.code, statut:erreur.status, requeteId:erreur.requestId ?? null,
    reessayerApres:erreur.retryAfter ?? null,
    sessionRejetee:authentifie && erreur.status === 401 && erreur.code === 'session_rejected',
    defiDeuxFacteurs:false,
  };
  if (erreur instanceof ErreurRest) return {
    code:erreur.errorType ?? 'server_error', statut:erreur.statut, requeteId:null,
    reessayerApres:null, sessionRejetee:authentifie && estJetonRefuse(erreur),
    defiDeuxFacteurs:erreur instanceof ErreurDeuxFacteurs,
  };
  return {code:'connection_failed', statut:0, requeteId:null, reessayerApres:null, sessionRejetee:false, defiDeuxFacteurs:false};
}
