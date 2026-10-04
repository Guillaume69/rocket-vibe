/**
 * Cible de réponse (citation) — canal entre la feuille d'actions et le composer.
 *
 * Même famille que `sourcePieceJointe`, mais en ÉTAT OBSERVABLE plutôt qu'en
 * promesse : la feuille arme la cible puis se ferme ; le composer, monté bien
 * avant, l'affiche dans son bandeau tant qu'elle vit — annulée (✕, back), ou
 * soldée par l'envoi. Clé = `rid` pour le salon, `rid:filId` pour un fil : les
 * deux composers peuvent coexister (le fil est empilé sur le salon) sans se
 * voler la cible. Mémoire seule, volontairement : contrairement au brouillon,
 * une citation en suspens ne survit ni au redémarrage ni à la FIN DE SESSION.
 *
 * Le « ni à la fin de session » a longtemps été une intention, pas un fait :
 * une déconnexion ne démonte que l'arbre React, elle n'efface pas un store de
 * module. Le permalien retenu embarque la `baseUrl` (`lib/citation.ts`), donc
 * le premier message tapé après reconnexion partait préfixé du permalien de la
 * session précédente — l'ancien serveur cité dans un message posté sur le
 * nouveau. D'où `oublierReponses`, appelé au démontage de `SynchroProvider`.
 */

import { useSyncExternalStore } from 'react';

export type CibleReponse = {
  /** `_id` du message cité. */
  id: string;
  /** Username de l'auteur cité — l'instantané suffit pour un bandeau. */
  auteur: string | null;
  /** Extrait du texte cité, déjà purgé de son propre permalien de citation. */
  apercu: string | null;
  /** Permalien `?msg=` — deviendra le préfixe `[ ](…)` à l'envoi. */
  permalien: string;
  /** Pièce jointe de citation prête pour l'affichage optimiste
   *  (`jointeCitationLocale`) — pièces du cité incluses, chaîne taillée à 2. */
  jointeLocale: string;
  /** URL (relative) de la première image du cité — vignette du bandeau. */
  imageApercu: string | null;
  native?: import('../fournisseurs/rocketvibe/quotes.ts').NativeQuoteSelection;
  nativeIndisponible?: boolean;
};

const cibles = new Map<string, CibleReponse>();
const abonnes = new Set<() => void>();

function notifier(): void {
  for (const abonne of abonnes) abonne();
}

export function demanderReponse(cle: string, cible: CibleReponse): void {
  cibles.set(cle, cible);
  notifier();
}

export function annulerReponse(cle: string): void {
  if (cibles.delete(cle)) notifier();
}
export function lireReponse(cle:string):CibleReponse|null { return cibles.get(cle)??null; }
/** Only the still-selected private reference may recover a fresh preview. */
export function actualiserReponsePrivee(cle:string,cible:CibleReponse,preview:{author:string;text:string}):void {
  if(!cible.native?.crypto_admission)return;
  actualiserReponseNative(cle,cible,preview);
}
/** Refresh either kind of reference inside the protected conversation. */
export function actualiserReponseNative(cle:string,cible:CibleReponse,preview:{author:string;text:string}):void {
  const actuelle=cibles.get(cle);
  if(!cible.native || actuelle?.native!==cible.native)return;
  const apercu=preview.text.trim()||null;
  if(actuelle.auteur===preview.author && actuelle.apercu===apercu && !actuelle.nativeIndisponible)return;
  demanderReponse(cle,{...actuelle,auteur:preview.author,apercu,imageApercu:null,jointeLocale:'[]',nativeIndisponible:false});
}

/** A delayed enqueue must not consume a target selected in the meantime. */
export function annulerReponseSi(cle: string, cible: CibleReponse): void {
  const actuelle = cibles.get(cle);
  if (actuelle === cible || cible.native !== undefined && actuelle?.native === cible.native) annulerReponse(cle);
}

/** Keep the selection for validation, while discarding its private preview. */
export function invaliderReponseNative(cle: string, cible: CibleReponse): void {
  if (cibles.get(cle) !== cible || cible.nativeIndisponible) return;
  demanderReponse(cle, {...cible, auteur:null, apercu:null, imageApercu:null, jointeLocale:'[]', nativeIndisponible:true});
}

/** Fin de session / changement de serveur : aucune citation ne traverse. */
export function oublierReponses(): void {
  if (cibles.size === 0) return;
  cibles.clear();
  notifier();
}

function souscrire(relire: () => void): () => void {
  abonnes.add(relire);
  return () => {
    abonnes.delete(relire);
  };
}

/** La cible armée pour cette clé, `null` sinon. Se met à jour toute seule. */
export function useReponse(cle: string): CibleReponse | null {
  return useSyncExternalStore(souscrire, () => cibles.get(cle) ?? null);
}
