/**
 * Catalogue de traduction — le SEUL point de vérité des chaînes affichées.
 *
 * `fr` est la RÉFÉRENCE : ses clés définissent `CleTraduction`. `en` est typé
 * `Record<CleTraduction, string>`, donc TypeScript refuse à la compilation toute
 * clé manquante OU en trop — les deux langues restent structurellement jumelles
 * sans qu'on ait à le vérifier à la main. `npx tsc --noEmit` est le garde-fou.
 *
 * Convention de clés : `espace.nom`, un espace de noms par écran ou composant
 * (`connexion.*`, `salon.*`…), plus `commun.*` pour ce qui se répète partout et
 * `sys.*` pour les messages système Rocket.Chat. Interpolation `{param}` ;
 * pluriel `singulier | pluriel` choisi par le paramètre numérique `n`
 * (cf. `ui/i18n.tsx`).
 */

const fr = {
  // ── Commun — réutilisé par plusieurs écrans. Préférer une clé d'écran
  //    quand la formulation est propre à un contexte.
  'commun.enregistrer': 'Enregistrer',
  'commun.annuler': 'Annuler',
  'commun.reessayer': 'Réessayer',
  'commun.fermer': 'Fermer',
  'commun.erreur': 'Erreur',
  'commun.envoyer': 'Envoyer',
  'commun.rechercher': 'Rechercher',
  'commun.chargement': 'Chargement…',
  'commun.supprimer': 'Supprimer',
  'commun.copier': 'Copier',
  'commun.ok': 'OK',

  // ── Langue (sélecteur des paramètres). Les noms de langue eux-mêmes sont des
  //    endonymes (cf. NOMS_LANGUE dans i18n.ts), identiques dans toutes les
  //    langues ; seule l'option « automatique » se traduit.
  'langue.auto': 'Automatique',
  'langue.autoAide': 'Suit la langue du téléphone',

  // ── Paramètres
  'parametres.titre': 'Paramètres',
  'parametres.modifierProfil': 'Modifier mon profil',
  'parametres.sectionNotifications': 'Notifications',
  'parametres.push': 'Notifications push',
  'parametres.pushAide': 'Quels messages déclenchent une notification sur cet appareil.',
  'parametres.pushTous': 'Tous les messages',
  'parametres.pushMentions': 'Mentions et messages directs',
  'parametres.pushAucune': 'Aucune',
  'parametres.pushIntrouvable': 'Préférence de notification introuvable.',
  'parametres.enregistrementImpossible': 'Enregistrement impossible — réessaie.',
  'parametres.sectionLangue': 'Langue',
  'parametres.langueAide': "La langue de l'application.",
  'parametres.sectionCompte': 'Compte',
  'parametres.connecte': 'Connecté',
  'parametres.serveur': 'Serveur',
  'parametres.sectionDiagnostic': 'Diagnostic',
  'parametres.obtenirJeton': 'Obtenir le jeton FCM',
  'parametres.changerServeur': 'Changer de serveur',
  'parametres.seDeconnecter': 'Se déconnecter',

  // ── Ligne de message (salon et fil)
  'ligneMessage.profilDe': 'Profil de {nom}',
  'ligneMessage.modifie': '(modifié)',
  'ligneMessage.envoiEnCours': '⏳ envoi…',
  'ligneMessage.reponses': '{n} réponse | {n} réponses',
  'ligneMessage.echecReessayer': '⚠️ Échec — réessayer',
  'ligneMessage.abandonner': 'abandonner',
  'ligneMessage.chiffre': '🔒 Message chiffré, non pris en charge',
  'ligneMessage.messageVide': '(message vide)',
  'ligneMessage.appelVideo': '📞 Appel vidéo',
  'ligneMessage.rejoindreAppel': "Rejoindre l'appel",
  'ligneMessage.rejoindre': 'Rejoindre',
  'ligneMessage.imageAgrandir': 'Image, toucher pour agrandir',
  'ligneMessage.fichier': 'Fichier',

  // ── Messages système Rocket.Chat (le champ `t` d'un message). `{p}` = le
  //    paramètre porté par `msg` (nom ajouté, nouveau sujet…).
  'sys.uj': 'a rejoint le salon',
  'sys.ujt': "a rejoint l'équipe",
  'sys.ul': 'a quitté le salon',
  'sys.ult': "a quitté l'équipe",
  'sys.ru': 'a retiré {p} du salon',
  'sys.au': 'a ajouté {p} au salon',
  'sys.r': 'a renommé le salon en {p}',
  'sys.rm': '(message supprimé)',
  'sys.wmVide': 'bienvenue !',
  'sys.wm': 'bienvenue, {p} !',
  'sys.uploaded': 'a envoyé le fichier {p}',
  'sys.messagePinned': 'a épinglé un message',
  'sys.messageUnpinned': 'a désépinglé un message',
  'sys.topicRetire': 'a retiré le sujet',
  'sys.topic': 'a changé le sujet : {p}',
  'sys.annonceRetire': "a retiré l'annonce",
  'sys.annonce': "a changé l'annonce : {p}",
  'sys.descriptionRetire': 'a retiré la description',
  'sys.description': 'a changé la description : {p}',
  'sys.roomChangedAvatar': "a changé l'avatar du salon",
  'sys.roomChangedPrivacy': 'a changé la confidentialité du salon : {p}',
  'sys.setReadOnly': 'a passé le salon en lecture seule',
  'sys.removedReadOnly': 'a repassé le salon en écriture',
  'sys.archived': 'a archivé le salon',
  'sys.unarchived': 'a désarchivé le salon',
  'sys.userMuted': 'a rendu {p} muet',
  'sys.userUnmuted': 'a rendu la parole à {p}',
  'sys.roleAdded': 'a donné un rôle à {p}',
  'sys.roleRemoved': 'a retiré un rôle à {p}',
  'sys.allowedReacting': 'a autorisé les réactions',
  'sys.disallowedReacting': 'a interdit les réactions',
  'sys.messageDeleted': 'a supprimé un message',
  'sys.inconnu': '(action système « {type} »)',
  'sys.inconnuParam': '(action système « {type} » : {p})',
} as const;

/** Toutes les clés valides de traduction — dérivées de `fr`, la référence. */
export type CleTraduction = keyof typeof fr;

/**
 * Anglais. Typé `Record<CleTraduction, string>` : une clé oubliée ou en trop
 * casse la compilation. Garder le MÊME ordre que `fr` facilite la relecture.
 */
const en: Record<CleTraduction, string> = {
  'commun.enregistrer': 'Save',
  'commun.annuler': 'Cancel',
  'commun.reessayer': 'Retry',
  'commun.fermer': 'Close',
  'commun.erreur': 'Error',
  'commun.envoyer': 'Send',
  'commun.rechercher': 'Search',
  'commun.chargement': 'Loading…',
  'commun.supprimer': 'Delete',
  'commun.copier': 'Copy',
  'commun.ok': 'OK',

  'langue.auto': 'Automatic',
  'langue.autoAide': 'Follows the phone language',

  'parametres.titre': 'Settings',
  'parametres.modifierProfil': 'Edit my profile',
  'parametres.sectionNotifications': 'Notifications',
  'parametres.push': 'Push notifications',
  'parametres.pushAide': 'Which messages trigger a notification on this device.',
  'parametres.pushTous': 'All messages',
  'parametres.pushMentions': 'Mentions and direct messages',
  'parametres.pushAucune': 'None',
  'parametres.pushIntrouvable': 'Notification preference not found.',
  'parametres.enregistrementImpossible': "Couldn't save — try again.",
  'parametres.sectionLangue': 'Language',
  'parametres.langueAide': 'The app language.',
  'parametres.sectionCompte': 'Account',
  'parametres.connecte': 'Signed in',
  'parametres.serveur': 'Server',
  'parametres.sectionDiagnostic': 'Diagnostics',
  'parametres.obtenirJeton': 'Get the FCM token',
  'parametres.changerServeur': 'Change server',
  'parametres.seDeconnecter': 'Sign out',

  'ligneMessage.profilDe': 'Profile of {nom}',
  'ligneMessage.modifie': '(edited)',
  'ligneMessage.envoiEnCours': '⏳ sending…',
  'ligneMessage.reponses': '{n} reply | {n} replies',
  'ligneMessage.echecReessayer': '⚠️ Failed — retry',
  'ligneMessage.abandonner': 'discard',
  'ligneMessage.chiffre': '🔒 Encrypted message, not supported',
  'ligneMessage.messageVide': '(empty message)',
  'ligneMessage.appelVideo': '📞 Video call',
  'ligneMessage.rejoindreAppel': 'Join the call',
  'ligneMessage.rejoindre': 'Join',
  'ligneMessage.imageAgrandir': 'Image, tap to enlarge',
  'ligneMessage.fichier': 'File',

  'sys.uj': 'joined the channel',
  'sys.ujt': 'joined the team',
  'sys.ul': 'left the channel',
  'sys.ult': 'left the team',
  'sys.ru': 'removed {p} from the channel',
  'sys.au': 'added {p} to the channel',
  'sys.r': 'renamed the channel to {p}',
  'sys.rm': '(message removed)',
  'sys.wmVide': 'welcome!',
  'sys.wm': 'welcome, {p}!',
  'sys.uploaded': 'sent the file {p}',
  'sys.messagePinned': 'pinned a message',
  'sys.messageUnpinned': 'unpinned a message',
  'sys.topicRetire': 'removed the topic',
  'sys.topic': 'changed the topic: {p}',
  'sys.annonceRetire': 'removed the announcement',
  'sys.annonce': 'changed the announcement: {p}',
  'sys.descriptionRetire': 'removed the description',
  'sys.description': 'changed the description: {p}',
  'sys.roomChangedAvatar': "changed the channel's avatar",
  'sys.roomChangedPrivacy': "changed the channel's privacy: {p}",
  'sys.setReadOnly': 'set the channel to read-only',
  'sys.removedReadOnly': 'set the channel to writable',
  'sys.archived': 'archived the channel',
  'sys.unarchived': 'unarchived the channel',
  'sys.userMuted': 'muted {p}',
  'sys.userUnmuted': 'unmuted {p}',
  'sys.roleAdded': 'gave a role to {p}',
  'sys.roleRemoved': 'removed a role from {p}',
  'sys.allowedReacting': 'allowed reactions',
  'sys.disallowedReacting': 'disallowed reactions',
  'sys.messageDeleted': 'deleted a message',
  'sys.inconnu': '(system action “{type}”)',
  'sys.inconnuParam': '(system action “{type}”: {p})',
};

/** Les deux catalogues, prêts à l'indexation par langue. */
export const CATALOGUES = { fr, en } as const;

/** Langues disponibles — dérivées des catalogues, jamais désynchronisées. */
export type Langue = keyof typeof CATALOGUES;
export const LANGUES = Object.keys(CATALOGUES) as readonly Langue[];

/** Préférence stockée : une langue explicite, ou « suivre l'appareil ». */
export type PreferenceLangue = Langue | 'auto';

/**
 * Noms de langue en ENDONYME (dans la langue elle-même) : « Français » et
 * « English » se lisent pareil quelle que soit la langue de l'interface —
 * convention des sélecteurs de langue.
 */
export const NOMS_LANGUE: Record<Langue, string> = {
  fr: 'Français',
  en: 'English',
};

export type ParamsTraduction = Record<string, string | number>;
export type Traducteur = (cle: CleTraduction, params?: ParamsTraduction) => string;

/**
 * Langue du téléphone, en PUR JS : Hermes (RN 0.86) embarque `Intl`/ICU adossé
 * à `Locale.getDefault()` d'Android. Aucun module natif — donc pas de rebuild du
 * dev-client ni de dépendance à justifier (ROADMAP §4.2) — et ça tourne tel quel
 * sous Node. Repli sur l'anglais pour toute locale non couverte (défaut
 * international neutre).
 */
export function langueAppareil(): Langue {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const sousTag = locale.split(/[-_]/)[0]?.toLowerCase();
  return sousTag === 'fr' ? 'fr' : 'en';
}

/**
 * Sélection singulier/pluriel. FR : singulier pour 0 et 1 (« 0 membre »,
 * « 1 membre »), pluriel dès 2. EN : singulier pour 1 seulement.
 */
function estPluriel(langue: Langue, n: number): boolean {
  return langue === 'fr' ? n > 1 : n !== 1;
}

/**
 * Rend le modèle final : d'abord le choix du pluriel (`singulier | pluriel`
 * arbitré par le paramètre numérique `n`), puis la substitution des `{param}`.
 * Un `{param}` sans valeur est laissé TEL QUEL — plus parlant qu'un « undefined »
 * en pleine phrase pour repérer un oubli d'argument.
 */
function interpoler(
  modele: string,
  params: ParamsTraduction | undefined,
  langue: Langue,
): string {
  let s = modele;
  if (s.includes(' | ') && typeof params?.n === 'number') {
    const [singulier, pluriel] = s.split(' | ');
    s = (estPluriel(langue, params.n) ? pluriel : singulier) ?? s;
  }
  if (params === undefined) return s;
  return s.replace(/\{(\w+)\}/g, (brut, cle: string) =>
    cle in params ? String(params[cle]) : brut,
  );
}

/**
 * Traduit une clé dans une langue. Repli sur le français (la référence) si une
 * clé venait à manquer côté cible — impossible en théorie (le type l'interdit),
 * mais un texte français reste préférable à une clé brute affichée.
 */
export function traduire(
  langue: Langue,
  cle: CleTraduction,
  params?: ParamsTraduction,
): string {
  const modele = CATALOGUES[langue][cle] ?? CATALOGUES.fr[cle];
  return interpoler(modele, params, langue);
}
