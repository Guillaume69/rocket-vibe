/**
 * Traduction des messages système Rocket.Chat (`t` sur le message).
 *
 * Conventions du serveur, relevées sur 8.5 : pour la plupart des types, `msg`
 * porte le PARAMÈTRE de l'action (le nom de l'utilisateur ajouté, le nouveau
 * nom du salon, le sujet…), pas une phrase. C'est `u` (l'auteur) qui a agi.
 *
 * Un type inconnu rend une phrase générique plutôt que rien : le serveur en
 * ajoute à chaque version, et un salon qui « perd » des événements est plus
 * déroutant qu'une mention neutre.
 */

const TRADUCTIONS: Record<string, (parametre: string) => string> = {
  uj: () => 'a rejoint le salon',
  ujt: () => "a rejoint l'équipe",
  ul: () => 'a quitté le salon',
  ult: () => "a quitté l'équipe",
  ru: (p) => `a retiré ${p} du salon`,
  au: (p) => `a ajouté ${p} au salon`,
  r: (p) => `a renommé le salon en ${p}`,
  // Sur une pierre tombale `rm`, `u` reste l'AUTEUR D'ORIGINE — le modérateur
  // qui a supprimé est dans `editedBy`. Une tournure active accuserait le
  // mauvais acteur : on reste neutre.
  rm: () => '(message supprimé)',
  wm: (p) => (p === '' ? 'bienvenue !' : `bienvenue, ${p} !`),
  uploaded: (p) => `a envoyé le fichier ${p}`,
  message_pinned: () => 'a épinglé un message',
  message_unpinned: () => 'a désépinglé un message',
  // Effacer le sujet émet le même type avec un `msg` VIDE : sans ce cas, la
  // phrase finirait sur un deux-points pendu.
  room_changed_topic: (p) => (p === '' ? 'a retiré le sujet' : `a changé le sujet : ${p}`),
  room_changed_announcement: (p) =>
    p === '' ? "a retiré l'annonce" : `a changé l'annonce : ${p}`,
  room_changed_description: (p) =>
    p === '' ? 'a retiré la description' : `a changé la description : ${p}`,
  room_changed_avatar: () => "a changé l'avatar du salon",
  room_changed_privacy: (p) => `a changé la confidentialité du salon : ${p}`,
  'room-set-read-only': () => 'a passé le salon en lecture seule',
  'room-removed-read-only': () => 'a repassé le salon en écriture',
  'room-archived': () => 'a archivé le salon',
  'room-unarchived': () => 'a désarchivé le salon',
  'user-muted': (p) => `a rendu ${p} muet`,
  'user-unmuted': (p) => `a rendu la parole à ${p}`,
  'subscription-role-added': (p) => `a donné un rôle à ${p}`,
  'subscription-role-removed': (p) => `a retiré un rôle à ${p}`,
  'room-allowed-reacting': () => 'a autorisé les réactions',
  'room-disallowed-reacting': () => 'a interdit les réactions',
  'message-deleted-notification': () => 'a supprimé un message',
};

/**
 * Phrase française d'un message système. `parametre` est le `msg` brut du
 * message — vide pour les actions qui n'en ont pas.
 */
export function texteSysteme(type: string, parametre: string | null): string {
  const traduire = TRADUCTIONS[type];
  if (traduire !== undefined) return traduire(parametre ?? '');
  const suffixe = parametre !== null && parametre !== '' ? ` : ${parametre}` : '';
  return `(action système « ${type} »${suffixe})`;
}
