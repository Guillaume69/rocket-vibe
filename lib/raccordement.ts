/**
 * Ordonnancement d'un raccordement : le stream et le rattrapage REST.
 *
 * Les deux transports sont indépendants — REST pour lire, DDP pour écouter —
 * mais leur ORDRE compte :
 *
 * - Souscrire AVANT de lire ne laisse aucune fenêtre : un message posté pendant
 *   la lecture arrive quand même, par le stream. C'est l'ordre canonique.
 * - Lire sans attendre le stream fait apparaître les messages tout de suite,
 *   mais laisse un trou entre la fin de la lecture et l'établissement du
 *   stream.
 *
 * D'où la course : on laisse au stream un DÉLAI DE GRÂCE pour gagner (il gagne
 * presque toujours — mesuré ~0,9 s sur l'émulateur), et passé ce délai on lit
 * sans lui. Une socket qui n'aboutira pas met, elle, tout le timeout de
 * négociation (10 s) : la faire attendre à l'utilisateur figeait le salon
 * ouvert au retour de l'arrière-plan — on croyait n'avoir rien reçu alors qu'un
 * message était là (17 s mesurées entre le retour et l'affichage).
 *
 * Quand le stream perd la course, la fenêtre existe : une SECONDE passe la
 * couvre, sur curseur frais donc quasi vide.
 *
 * L'échec du stream reste l'échec du raccordement — le pilote de reconnexion
 * garde son backoff — mais il n'est relayé qu'à la FIN : l'utilisateur a
 * d'abord eu ses messages.
 *
 * Pur : l'attente est injectable, tout se teste sous Node sans dormir.
 */

export type OptionsRaccordement = {
  /**
   * Ouvre le stream et s'authentifie. Doit se résoudre immédiatement si la
   * socket est déjà vivante — la course n'a alors rien à arbitrer.
   */
  ouvrirStream: () => Promise<void>;
  /** Rattrapage REST. Appelé une fois, deux si le stream perd la course. */
  rattraper: () => Promise<void>;
  /**
   * Ce qui suit le rattrapage sans dépendre du stream (files d'envoi,
   * présence, réveil des écrans). Joué UNE fois, avant que l'échec éventuel du
   * stream ne soit relayé.
   */
  ensuite?: () => void;
  /** Coupe court : session terminée pendant le raccordement. */
  estAbandonne?: () => boolean;
  graceMs?: number;
  patienter?: (ms: number) => Promise<void>;
};

/** Ce qu'on accorde au stream pour gagner la course. */
export const GRACE_STREAM_MS = 1_500;

const attenteReelle = (ms: number): Promise<void> =>
  new Promise((resoudre) => setTimeout(resoudre, ms));

export async function raccorder(options: OptionsRaccordement): Promise<void> {
  const {
    ouvrirStream,
    rattraper,
    ensuite,
    estAbandonne = () => false,
    graceMs = GRACE_STREAM_MS,
    patienter = attenteReelle,
  } = options;

  let streamPret = false;
  // Observé TOUT DE SUITE : sans cette absorption, un rejet du stream pendant
  // qu'on rattrape remonterait en « unhandled rejection ». L'erreur est
  // conservée comme VALEUR, pour être relevée à la fin.
  const echecStream = ouvrirStream().then(
    (): Error | null => {
      streamPret = true;
      return null;
    },
    (e: unknown): Error => (e instanceof Error ? e : new Error(String(e))),
  );

  await Promise.race([echecStream, patienter(graceMs)]);
  if (estAbandonne()) return;

  await rattraper();
  // Le stream était-il là quand le rattrapage a rendu la main ? Sinon,
  // l'intervalle entre les deux n'est vu par personne : ni par le REST (déjà
  // fini), ni par les souscriptions (pas encore là).
  const streamCouvrait = streamPret;

  ensuite?.();

  const erreur = await echecStream;
  if (erreur !== null) throw erreur;
  if (!streamCouvrait && !estAbandonne()) await rattraper();
}
