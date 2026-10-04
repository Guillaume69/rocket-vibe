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
 *
 * Les phrases elles-mêmes vivent dans le catalogue (`ui/messages`, clés `sys.*`) :
 * ce module reste PUR — le traducteur `t` est INJECTÉ (import de type seul, aucun
 * import plateforme), donc ses tests tournent sous Node avec un `t` réel.
 */

import type { TranslateFn } from '../ui/messages.ts';

/**
 * Table type → clé de traduction. Les types dont le rendu dépend d'un paramètre
 * (`{p}`) le reçoivent à l'appel ; les cas où un `msg` VIDE change la phrase
 * (sujet effacé, bienvenue anonyme) sont traités à part dans `texteSysteme`.
 */
const KEYS = {
  uj: 'sys.uj',
  ujt: 'sys.ujt',
  ul: 'sys.ul',
  ult: 'sys.ult',
  ru: 'sys.ru',
  au: 'sys.au',
  r: 'sys.r',
  rm: 'sys.rm',
  uploaded: 'sys.uploaded',
  message_pinned: 'sys.messagePinned',
  message_unpinned: 'sys.messageUnpinned',
  // Épingler dans un salon CHIFFRÉ produit un type distinct côté serveur —
  // relevé dans le bundle 8.5.1 : `originalMessage.t === 'e2e' ?
  // 'message_pinned_e2e' : 'message_pinned'`. Sans ces deux lignes, la ligne
  // s'affiche « (action système « message_pinned_e2e ») ». Le libellé est le
  // même : ce qui est épinglé reste un message.
  message_pinned_e2e: 'sys.messagePinned',
  message_unpinned_e2e: 'sys.messageUnpinned',
  room_changed_avatar: 'sys.roomChangedAvatar',
  room_changed_privacy: 'sys.roomChangedPrivacy',
  'room-set-read-only': 'sys.setReadOnly',
  'room-removed-read-only': 'sys.removedReadOnly',
  'room-archived': 'sys.archived',
  'room-unarchived': 'sys.unarchived',
  'user-muted': 'sys.userMuted',
  'user-unmuted': 'sys.userUnmuted',
  'subscription-role-added': 'sys.roleAdded',
  'subscription-role-removed': 'sys.roleRemoved',
  'room-allowed-reacting': 'sys.allowedReacting',
  'room-disallowed-reacting': 'sys.disallowedReacting',
  'message-deleted-notification': 'sys.messageDeleted',
} as const satisfies Record<string, Parameters<TranslateFn>[0]>;

/** Types dont un `msg` VIDE efface la partie « : … » — traités hors table. */
const WITH_EMPTY_CASE = {
  room_changed_topic: { removed: 'sys.topicRemoved', full: 'sys.topic' },
  room_changed_announcement: { removed: 'sys.announcementRemoved', full: 'sys.announcement' },
  room_changed_description: { removed: 'sys.descriptionRemoved', full: 'sys.description' },
} as const satisfies Record<string, { removed: Parameters<TranslateFn>[0]; full: Parameters<TranslateFn>[0] }>;

/**
 * Phrase d'un message système, dans la langue portée par `t`. `parametre` est
 * le `msg` brut du message — vide pour les actions qui n'en ont pas.
 */
export function systemText(t: TranslateFn, type: string, param: string | null): string {
  const p = param ?? '';

  // Bienvenue : `msg` vide = accueil anonyme (« bienvenue ! »), sinon nominatif.
  if (type === 'wm') return p === '' ? t('sys.wmEmpty') : t('sys.wm', { p });

  const cases = WITH_EMPTY_CASE[type as keyof typeof WITH_EMPTY_CASE];
  if (cases !== undefined) return p === '' ? t(cases.removed) : t(cases.full, { p });

  const key = KEYS[type as keyof typeof KEYS];
  if (key !== undefined) return t(key, { p });

  // Type inconnu : phrase générique. Le deux-points ne pend pas quand `msg` est vide.
  return p === '' ? t('sys.unknown', { type }) : t('sys.unknownWithParam', { type, p });
}

/**
 * Libellé d'APERÇU pour la liste des salons, quand le dernier message n'a aucun
 * texte à montrer (`dernier_message` null alors que le salon a bien un dernier
 * message — voir `dernierMessageType`). `null` = rien à dire, la ligne reste
 * vide comme avant.
 *
 * Volontairement SÉPARÉ de `texteSysteme` : ses phrases sont des prédicats, qui
 * se lisent à la suite du nom d'auteur affiché juste au-dessus dans le fil
 * (« bob » + « a rejoint le salon »). La liste des salons n'affiche aucun
 * auteur : y coller le même texte donnerait « a rejoint le salon », sans sujet.
 * D'où un libellé autonome, et seulement pour les types qui en ont besoin —
 * aujourd'hui l'appel vidéo, le seul dont le contenu vive entièrement dans
 * `blocks`.
 */
export function systemPreview(t: TranslateFn, type: string | null): string | null {
  return type === 'videoconf' ? t('home.callPreview') : null;
}
