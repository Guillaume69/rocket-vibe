/**
 * Ordonnancement d'un raccordement : le stream et le rattrapage REST.
 *
 * Les deux transports sont indépendants — REST pour lire, DDP pour écouter —
 * mais leur ORDRE décide de ce qui peut se perdre :
 *
 * - Une lecture REST démarrée APRÈS l'armement des souscriptions ne laisse
 *   aucun trou : tout ce que le serveur publie ensuite arrive par le fil.
 * - Une lecture démarrée AVANT peut être évaluée côté serveur pendant que le
 *   stream n'écoute pas encore. Ce que le serveur publie dans cet intervalle
 *   n'est vu par personne — et comme la lecture a fait avancer les curseurs,
 *   plus rien ne le redemande.
 *
 * D'où deux lectures, et non une course entre elles :
 *
 * 1. **Tout de suite**, sans attendre le stream — c'est ce que l'utilisateur
 *    voit. Séquencer cette lecture derrière la socket faisait payer le timeout
 *    de négociation DDP à chaque retour de l'arrière-plan : le salon ouvert
 *    restait figé et on croyait n'avoir rien reçu (17 s mesurées entre le
 *    retour et l'affichage d'un message déjà posté, jusqu'à deux minutes quand
 *    plusieurs sockets échouaient de suite).
 * 2. **Après l'armement des souscriptions** — c'est celle qui GARANTIT. Elle
 *    attend un signal (`souscriptionsArmees`, le `ready` du serveur), jamais un
 *    délai : la justesse ne dépend donc ni de la latence ni de la qualité du
 *    réseau, seulement de l'ordre des événements.
 *
 * La seconde saute quand le stream était DÉJÀ actif au départ : la lecture (1)
 * a alors elle-même démarré après l'armement, elle garantit à elle seule. C'est
 * le cas de toute retentative sur socket vivante — donc de la majorité.
 *
 * L'échec du stream reste l'échec du raccordement — le pilote de reconnexion
 * garde son backoff — mais il n'est relayé qu'à la FIN : l'utilisateur a
 * d'abord eu ses messages.
 *
 * Pur : tout se teste sous Node, sans réseau et sans horloge.
 */

export type HookupOptions = {
  /**
   * Le stream est-il DÉJÀ actif, souscriptions armées ? Évalué avant tout le
   * reste : c'est ce qui dit si la première lecture garantit à elle seule.
   */
  streamAlreadyActive: () => boolean;
  /**
   * Ouvre le stream, s'authentifie et rejoue les souscriptions désirées. Se
   * résout immédiatement si la socket est déjà vivante.
   */
  openStream: () => Promise<void>;
  /** Résolue quand le serveur a armé les souscriptions. Ne rejette pas. */
  streamArmed: () => Promise<void>;
  /** Rattrapage REST. Appelé une fois, deux si le stream vient d'être branché. */
  catchUp: () => Promise<void>;
  /**
   * Ce qui suit la lecture sans dépendre du stream (files d'envoi, présence,
   * réveil des écrans). Joué UNE fois, avant que l'échec éventuel du stream ne
   * soit relayé.
   */
  then?: () => void;
  /** Coupe court : session terminée pendant le raccordement. */
  isDiscarded?: () => boolean;
};

export async function hookUp(options: HookupOptions): Promise<void> {
  const {
    streamAlreadyActive,
    openStream,
    streamArmed,
    catchUp,
    then,
    isDiscarded = () => false,
  } = options;

  // Lu AVANT d'ouvrir quoi que ce soit : la question est bien « le stream
  // couvrait-il déjà quand la lecture ci-dessous a démarré ? ».
  const alreadyCovered = streamAlreadyActive();

  // L'issue du stream est observée TOUT DE SUITE — sans cette absorption, son
  // rejet pendant la lecture remonterait en « unhandled rejection ». L'erreur
  // est conservée comme VALEUR, pour être relevée à la fin.
  const streamFailure = openStream().then(
    (): Error | null => null,
    (e: unknown): Error => (e instanceof Error ? e : new Error(String(e))),
  );

  if (isDiscarded()) {
    await streamFailure;
    return;
  }
  await catchUp();
  then?.();

  const error = await streamFailure;
  if (error !== null) throw error;
  // Sans stream, il n'y a pas d'intervalle à couvrir : la prochaine tentative
  // du pilote refera l'ensemble.
  if (alreadyCovered || isDiscarded()) return;

  // Le stream vient d'être branché : on attend que le serveur ait ARMÉ nos
  // souscriptions, puis on relit. Cette lecture-là a forcément démarré après
  // l'armement — quelle que soit la latence — donc plus rien ne peut tomber
  // entre les deux transports. Curseurs frais : la réponse est quasi vide.
  await streamArmed();
  if (isDiscarded()) return;
  await catchUp();
}
