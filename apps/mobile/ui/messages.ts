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
 * (cf. `ui/i18n.ts`).
 */

import { dayKey } from './daySeparator.ts';

const fr = {
  // ── Commun — réutilisé par plusieurs écrans. Préférer une clé d'écran
  //    quand la formulation est propre à un contexte.
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
  'common.retry': 'Réessayer',
  'common.close': 'Fermer',
  'common.send': 'Envoyer',
  'common.search': 'Rechercher',
  'common.delete': 'Supprimer',
  'common.attachment': 'Pièce jointe',
  // Mise en phrase des refus de validation d'upload (ui/fileValidation.ts),
  // partagée entre le composer du salon et l'écran de partage.
  'common.fileTooLarge': 'Fichier trop lourd (maximum {mb} Mo).',
  'common.fileTypeRejected': 'Type {type} refusé par le serveur.',
  'common.encryptedFilesDisabled': 'Ce serveur n’accepte pas de fichiers dans un salon chiffré.',
  // Présence, en minuscule — la casse d'un contexte (sélecteur) est à
  // l'appelant. Table statut → clé : CLES_PRESENCE (ui/presence.ts).
  'common.presenceOnline': 'en ligne',
  'common.presenceAway': 'absent',
  'common.presenceBusy': 'occupé',
  'common.presenceOffline': 'hors ligne',

  // ── Langue (sélecteur des paramètres). Les noms de langue eux-mêmes sont des
  //    endonymes (cf. NOMS_LANGUE plus bas), identiques dans toutes les
  //    langues ; seule l'option « automatique » se traduit.
  'language.auto': 'Automatique',
  'language.autoHelp': 'Suit la langue du téléphone',

  // ── Paramètres
  'settings.title': 'Paramètres',
  'settings.editProfile': 'Modifier mon profil',
  'settings.sectionNotifications': 'Notifications',
  'settings.push': 'Notifications push',
  'settings.pushHelp': 'Quels messages déclenchent une notification sur cet appareil.',
  'settings.pushAll': 'Tous les messages',
  'settings.pushMentions': 'Mentions et messages directs',
  'settings.pushNone': 'Aucune',
  'settings.pushNotFound': 'Préférence de notification introuvable.',
  'settings.saveFailed': 'Enregistrement impossible — réessaie.',
  'settings.sectionLanguage': 'Langue',
  'settings.languageHelp': "La langue de l'application.",
  'settings.sectionAccount': 'Compte',
  'settings.signedIn': 'Connecté',
  'settings.server': 'Serveur',
  'settings.sectionDiagnostics': 'Diagnostic',
  'settings.getToken': 'Obtenir le jeton FCM',
  'settings.switchServer': 'Changer de serveur',
  'settings.signOut': 'Se déconnecter',

  // ── Ligne de message (salon et fil)
  'messageRow.profileOf': 'Profil de {name}',
  'messageRow.edited': '(modifié)',
  'messageRow.sending': '⏳ envoi…',
  'messageRow.replies': '{n} réponse | {n} réponses',
  'messageRow.failedRetry': '⚠️ Échec — réessayer',
  'messageRow.discard': 'abandonner',
  'messageRow.encrypted': '🔒 Message chiffré, non pris en charge',
  'messageRow.emptyMessage': '(message vide)',
  'messageRow.videoCall': '📞 Appel vidéo',
  'messageRow.joinCall': "Rejoindre l'appel",
  'messageRow.join': 'Rejoindre',
  'messageRow.imageEnlarge': 'Image, toucher pour agrandir',
  'messageRow.file': 'Fichier',
  'messageRow.fileUnreadable': '🔒 Fichier chiffré illisible',
  'messageRow.fileOpenFailed': "Impossible d'ouvrir ce fichier.",

  // ── Connexion (serveur → identifiants → second facteur)
  'login.title': 'Connexion',
  'login.tagline': 'Ton coin de chat magique ✨',
  'login.serverAddress': 'Adresse du serveur',
  'login.continue': 'Continuer',
  'login.knownServers': 'Serveurs connus',
  'login.usernameOrEmail': 'Identifiant ou email',
  'login.usernameExample': 'jean.dupont',
  'login.password': 'Mot de passe',
  'login.signIn': 'Se connecter',
  'login.switchServer': 'Changer de serveur',
  'login.noPasswordLogin': 'Ce serveur ne propose pas la connexion par mot de passe.',
  'login.serverUnreachable': 'Serveur injoignable.',
  'login.credentialsRejected': 'Identifiant ou mot de passe refusé.',
  'login.signInFailed': 'Connexion impossible.',
  'login.codeRejected': 'Code refusé. Réessaie.',
  'login.codePrepareFailed': 'Préparation du code impossible.',
  'login.codeSendFailed': "Impossible d'envoyer le code.",
  'login.networkHelp':
    "Depuis l'émulateur : `adb reverse tcp:3000 tcp:3000`. Depuis un téléphone : l'IP LAN de la machine.",
  'login.magicVerification': 'Vérification magique',
  'login.introEmail': 'Ce compte est protégé par un code envoyé par email.',
  'login.sendCode': "M'envoyer le code",
  'login.labelTotp': "Code de l'application d'authentification",
  'login.labelEmail': 'Code reçu par email',
  'login.labelPassword': 'Confirme ton mot de passe',
  'login.introPassword': 'Ressaisis ton mot de passe pour confirmer.',
  'login.introTotp': "Entre le code de ton application\nd'authentification ✨",
  'login.submit': 'Valider',
  'login.resendCode': 'Renvoyer le code',

  // ── Salon (écran d'un salon : liste + composer + en-tête)
  'room.newMessages': '✦ nouveaux messages',
  'room.jumpToLatest': 'Aller aux derniers messages',
  'room.marked': 'Messages épinglés et favoris',
  'room.jumpFailed': 'Message introuvable dans l’historique récent.',
  'daySeparator.today': "Aujourd'hui",
  'daySeparator.yesterday': 'Hier',
  'room.noMessages': 'Aucun message.',
  // Le « … » final est un contrat : `IndicateurSaisie` (ui/kit.tsx) le retire
  // pour le remplacer par ses points animés.
  'room.typingOne': '{name} écrit…',
  'room.typingTwo': '{a} et {b} écrivent…',
  'room.typingN': '{n} personnes écrivent…',
  'room.fileNotSent': '⚠️ {name} non envoyé',
  'room.filePending': '⏳ {name} en attente d’envoi',
  'room.fileSending': '⬆️ {name} — {percent} %',
  'room.threadReplyNotSent': '⚠️ Réponse de fil non envoyée — ouvrir',
  'room.retry': 'réessayer',
  'room.discard': 'abandonner',
  'room.encryptedLocked': '🔓 Déverrouiller pour lire ce salon chiffré',
  'e2e.title': 'Déverrouiller le chiffrement',
  'e2e.explanation':
    'Entre ton mot de passe de chiffrement E2E pour lire les salons chiffrés. Il déverrouille cet appareil une fois pour toutes.',
  'e2e.field': 'Mot de passe E2E',
  'e2e.unlock': 'Déverrouiller',
  'e2e.wrongPassword': 'Mot de passe incorrect.',
  'e2e.genericError': 'Déverrouillage impossible.',
  'settings.e2eTitle': 'Chiffrement de bout en bout',
  'settings.e2eLocked': 'Verrouillé — les salons chiffrés sont illisibles',
  'settings.e2eUnlocked': 'Déverrouillé sur cet appareil',
  'settings.e2eUnlock': 'Déverrouiller…',
  'settings.e2eLock': 'Verrouiller',
  'room.readOnly': 'Ce salon est en lecture seule.',
  'room.privateNote': 'Visible par toi uniquement',
  'room.commandRejected': 'Commande refusée : {error}',
  'room.uploadFailed': 'Téléversement impossible.',
  'room.microphoneDenied': 'Accès au micro refusé.',
  'room.recordingEmpty': 'Enregistrement vide.',
  'room.recordingFailed': 'Enregistrement impossible.',
  'room.cameraDenied': 'Accès à la caméra refusé.',
  'room.selectionFailed': 'Sélection impossible.',
  // Le NPE d'arbre de vues d'Android : rien dans l'app n'en sort, seul un
  // redémarrage le solde. Autant le dire clairement (voir `launchPicker.ts`).
  'room.pickerStuck': "Le sélecteur ne répond plus. Fermez l'app et rouvrez-la.",
  'room.attachFile': 'Joindre un fichier',
  'room.backToKeyboard': 'Revenir au clavier',
  'room.pickEmoji': 'Choisir un emoji',
  'room.addCaption': 'Ajouter une légende…',
  'room.messagePlaceholder': 'Message',
  'room.stopRecording': "Arrêter l'enregistrement",
  'room.voiceMessage': 'Message vocal',
  'room.callTitle': 'Appel',
  'room.callStartFailed': "Impossible de démarrer l'appel pour ce salon.",
  'room.back': 'Retour',
  'room.conversationInfo': 'Informations de la conversation',
  'room.startCall': 'Démarrer un appel vidéo',
  'room.replyingTo': 'Réponse à {name}',
  'room.cancelReply': 'Annuler la réponse',
  // ── Notification venue d'un AUTRE serveur que celui affiché. La bascule est
  //    un geste EXPLICITE : changer de serveur tout seul déplacerait le pointeur
  //    de reprise et la liste des salons sous les pieds de l'utilisateur.
  'room.otherServerTitle': 'Ce message est sur un autre serveur',
  'room.otherServerBody': 'Il vient de {host}.',
  'room.otherServerButton': 'Basculer sur ce serveur',
  'room.otherServerFailed': 'Aucune session enregistrée pour ce serveur.',

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
  'sys.wmEmpty': 'bienvenue !',
  'sys.wm': 'bienvenue, {p} !',
  'sys.uploaded': 'a envoyé le fichier {p}',
  'sys.messagePinned': 'a épinglé un message',
  'sys.messageUnpinned': 'a désépinglé un message',
  'sys.topicRemoved': 'a retiré le sujet',
  'sys.topic': 'a changé le sujet : {p}',
  'sys.announcementRemoved': "a retiré l'annonce",
  'sys.announcement': "a changé l'annonce : {p}",
  'sys.descriptionRemoved': 'a retiré la description',
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
  'sys.unknown': '(action système « {type} »)',
  'sys.unknownWithParam': '(action système « {type} » : {p})',

  // ── Accueil (liste des conversations)
  'home.settings': 'Paramètres',
  'home.sectionUnread': 'Non lus',
  'home.sectionFavorites': 'Favoris',
  'home.sectionRooms': 'Salons',
  'home.sectionDirectMessages': 'Messages privés',
  'home.sectionConversations': '{n} conversation | {n} conversations',
  'home.emptyList':
    "Aucun salon pour l'instant — la première synchronisation peut prendre quelques secondes.",
  'home.encryptedMessages': 'Messages chiffrés',
  // Aperçu d'un salon dont le dernier message est un appel vidéo : il n'a
  // aucun texte, son contenu vit dans ses `blocks`.
  'home.callPreview': 'Appel vidéo',
  'home.newConversation': 'Nouvelle conversation',

  // ── Recherche (nouvelle conversation)
  'search.title': 'Nouvelle conversation',
  'search.placeholder': 'Utilisateur ou canal…',
  'search.searchFailed': 'Recherche impossible.',
  'search.conversationFailed': 'Conversation impossible.',
  'search.joinFailed': 'Impossible de rejoindre.',
  'search.noResults': 'Aucun résultat.',

  // ── Recherche dans le salon
  'messageSearch.title': 'Rechercher dans le salon',
  'messageSearch.placeholder': 'Rechercher des messages…',
  'messageSearch.searchFailed': 'Recherche impossible.',
  'messageSearch.noMessages': 'Aucun message trouvé.',

  // ── Messages épinglés et favoris (app/marked-messages.tsx)
  'marked.title': 'Épinglés et favoris',
  'marked.pinned': 'Épinglés',
  'marked.starred': 'Mes favoris',
  'marked.noPinned': 'Aucun message épinglé.',
  'marked.noStarred': 'Aucun message en favori.',
  'marked.loadFailed': 'Chargement impossible.',

  // ── Fil de discussion — le composer commun (ui/composer.tsx) parle avec
  // les clés `salon.*` : les doublons `fil.*` ont été fusionnés (chantier 14).
  'thread.title': 'Fil',
  'thread.notFound': 'Fil introuvable.',
  'thread.reply': 'Répondre dans le fil',

  // ── Actions sur un message
  'messageActions.messageNotFound': 'Message introuvable.',
  'messageActions.noActions': 'Rien à faire sur ce message.',
  'messageActions.loadFailed': 'Chargement impossible.',
  'messageActions.actionRejected': 'Action refusée.',
  'messageActions.reply': 'Répondre',
  'messageActions.replyInThread': 'Répondre dans un fil',
  'messageActions.copy': 'Copier',
  'messageActions.share': 'Partager',
  'messageActions.save': 'Télécharger',
  'saved.gallery': 'Enregistré dans la galerie',
  'saved.downloads': 'Enregistré dans Téléchargements',
  'saved.failed': "Impossible d'enregistrer ce fichier.",
  'messageActions.edit': 'Modifier',
  'messageActions.pin': 'Épingler',
  'messageActions.unpin': 'Désépingler',
  'messageActions.star': 'Ajouter aux favoris',
  'messageActions.unstar': 'Retirer des favoris',

  // ── Joindre (menu de sources)
  'attach.photo': 'Prendre une photo',
  'attach.video': 'Prendre une vidéo',
  'attach.library': 'Choisir dans la bibliothèque',
  'attach.file': 'Choisir un fichier',

  // ── Partage entrant (ACTION_SEND)
  'share.title': 'Partager',
  'share.signInFirst': 'Connecte-toi pour partager dans une conversation.',
  'share.shareFailed': 'Partage impossible.',
  'share.addCaption': 'Ajouter une légende…',
  'share.messageToShare': 'Message à partager',
  'share.shareTo': 'Partager vers',
  'share.searchConversation': 'Rechercher une conversation…',
  'share.noConversations': 'Aucune conversation.',
  'share.encrypted': '🔒 Chiffré',
  'share.readOnly': 'Lecture seule',
  'share.removeAttachment': 'Retirer la pièce jointe',

  // ── Appel vidéo (WebView Jitsi)
  'call.videoCall': 'Appel vidéo',
  'call.joinFailed': "Impossible de rejoindre l'appel. Il est peut-être terminé.",
  'call.endCall': "Terminer l'appel",
  'call.end': 'Terminer',
  'call.connecting': 'Connexion à l’appel…',
  'call.loadFailed': "L'appel n'a pas pu se charger.",

  // ── Navigateur d'emojis
  'emojiPicker.search': 'Rechercher un emoji',
  'emojiPicker.clearSearch': 'Effacer la recherche',
  'emojiPicker.empty': 'Aucun emoji',
  'emojiPicker.custom': 'Personnalisés',
  'emojiPicker.people': 'Émotions',
  'emojiPicker.nature': 'Animaux et nature',
  'emojiPicker.food': 'Nourriture et boissons',
  'emojiPicker.activity': 'Activités',
  'emojiPicker.travel': 'Voyage et lieux',
  'emojiPicker.objects': 'Objets',
  'emojiPicker.symbols': 'Symboles',
  'emojiPicker.flags': 'Drapeaux',

  // ── Lecteurs média
  'audioPlayer.voiceMessage': 'Message vocal',
  'audioPlayer.play': 'Lire le message vocal',
  'audioPlayer.pause': 'Pause',
  'videoPlayer.video': 'Vidéo',
  'videoPlayer.play': 'Vidéo, toucher pour lire',
  'videoPlayer.playWithTitle': 'Vidéo : {title}, toucher pour lire',
  'viewer.image': 'Image',

  // ── Aperçu de pièce jointe
  'attachmentPreview.image': 'Image',
  'attachmentPreview.file': 'Fichier',
  'attachmentPreview.remove': 'Retirer la pièce jointe',
  'attachmentPreview.bytes': '{size} o',
  'attachmentPreview.kilobytes': '{size} Ko',
  'attachmentPreview.megabytes': '{size} Mo',
  // Pastilles du choix de qualité d'un média (photo lourde, vidéo) — la
  // réduction se fait à l'envoi (ui/prepareAttachment.ts).
  'attachmentPreview.reduced': 'Réduite',
  'attachmentPreview.original': 'Originale',
  'attachmentPreview.sendReduced': 'Envoyer en qualité réduite',
  'attachmentPreview.sendOriginal': "Envoyer en qualité d'origine",
  'attachmentPreview.preview': 'Aperçu de {name}',
  'attachmentPreview.openFailed': "Impossible d'ouvrir ce fichier.",

  // ── Cartes (aperçus de liens / embeds)
  'linkCard.imageEnlarge': 'Image, toucher pour agrandir',
  'linkCard.defaultLink': 'Lien',
  'linkCard.open': '{name}, toucher pour ouvrir',
  'embedCard.open': '{name}, toucher pour ouvrir',

  // ── Notifications (contenu masqué d'un salon chiffré)
  'notifications.encryptedTitle': 'Message chiffré',
  'notifications.encryptedBody': 'Nouveau message dans un salon chiffré.',

  // ── Synchro
  'sync.databaseUnavailable': 'Base locale inutilisable.',

  // ── Mon profil (édition)
  'myProfile.title': 'Mon profil',
  'myProfile.profileUnreadable': 'Profil illisible.',
  'myProfile.selectionFailed': 'Sélection impossible.',
  'myProfile.nothingToSave': 'Rien à enregistrer.',
  'myProfile.passwordRequired':
    'Ton mot de passe actuel est requis pour changer l’e-mail ou le nom d’utilisateur.',
  'myProfile.profileSaved': 'Profil enregistré ✨',
  'myProfile.codeRejected': 'Code refusé. Réessaie.',
  'myProfile.saveFailed': 'Enregistrement impossible.',
  'myProfile.codePrepareFailed': 'Préparation du code impossible.',
  'myProfile.changePhotoLabel': 'Changer la photo de profil',
  'myProfile.changePhoto': 'Changer la photo',
  'myProfile.sectionPresence': 'Présence',
  'myProfile.labelStatus': 'Texte de statut',
  'myProfile.placeholderStatus': 'En vacances ✨',
  'myProfile.sectionProfile': 'Profil',
  'myProfile.labelName': 'Nom affiché',
  'myProfile.placeholderName': 'Ton nom',
  'myProfile.labelBio': 'Bio',
  'myProfile.placeholderBio': 'Quelques mots sur toi',
  'myProfile.sectionAccount': 'Compte',
  'myProfile.accountHelp':
    'Changer l’e-mail ou le nom d’utilisateur demande ton mot de passe actuel — et parfois un code de vérification.',
  'myProfile.labelEmail': 'Adresse e-mail',
  'myProfile.placeholderEmail': 'toi@exemple.fr',
  'myProfile.labelUsername': 'Nom d’utilisateur',
  'myProfile.placeholderUsername': 'pseudo',
  'myProfile.labelPassword': 'Mot de passe actuel',
  'myProfile.verificationRequired': 'Vérification requise',
  'myProfile.help2faTotp': 'Entre le code de ton application d’authentification.',
  'myProfile.help2faEmail': 'Entre le code qui vient de t’être envoyé par e-mail.',
  'myProfile.help2faPassword': 'Ressaisis ton mot de passe pour confirmer.',
  'myProfile.labelCode': 'Code',
  'myProfile.submitCode': 'Valider le code',

  // ── Fiche d'un utilisateur
  'profile.profileUnreadable': 'Profil illisible.',
  'profile.profileNotFound': 'Profil introuvable.',
  'profile.actionFailed': 'Action impossible.',
  'profile.localTime': 'Heure locale : {time}',
  'profile.sendMessageLabel': 'Envoyer un message à {name}',
  'profile.messageButton': '💬 Message',
  'profile.callLabel': 'Appeler {name}',
  'profile.callButton': '📞 Appeler',

  // ── Fiche d'un salon
  'roomInfo.typePublicChannel': 'Canal public',
  'roomInfo.typePrivateGroup': 'Groupe privé',
  'roomInfo.typeDirectMessage': 'Message direct',
  'roomInfo.members': '{n} membre | {n} membres',
  'roomInfo.encrypted': 'chiffré',
  'roomInfo.readOnly': 'lecture seule',
  'roomInfo.detailsUnavailable': 'Détails indisponibles.',
  'roomInfo.announcement': 'Annonce',
  'roomInfo.topic': 'Sujet',
  'roomInfo.description': 'Description',
  'roomInfo.nothingSet': 'Ni description, ni sujet, ni annonce.',
  'roomInfo.addFavorite': 'Ajouter aux favoris',
  'roomInfo.removeFavorite': 'Retirer des favoris',
  'roomInfo.favoriteFailed': 'Favori non modifié : réessayez.',
} as const;

/** Toutes les clés valides de traduction — dérivées de `fr`, la référence. */
export type TranslationKey = keyof typeof fr;

/**
 * Anglais. Typé `Record<CleTraduction, string>` : une clé oubliée ou en trop
 * casse la compilation. Garder le MÊME ordre que `fr` facilite la relecture.
 */
const en: Record<TranslationKey, string> = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.send': 'Send',
  'common.search': 'Search',
  'common.delete': 'Delete',
  'common.attachment': 'Attachment',
  'common.fileTooLarge': 'File too large ({mb} MB maximum).',
  'common.fileTypeRejected': 'Type {type} rejected by the server.',
  'common.encryptedFilesDisabled': 'This server accepts no files in an encrypted room.',
  'common.presenceOnline': 'online',
  'common.presenceAway': 'away',
  'common.presenceBusy': 'busy',
  'common.presenceOffline': 'offline',

  'language.auto': 'Automatic',
  'language.autoHelp': 'Follows the phone language',

  'settings.title': 'Settings',
  'settings.editProfile': 'Edit my profile',
  'settings.sectionNotifications': 'Notifications',
  'settings.push': 'Push notifications',
  'settings.pushHelp': 'Which messages trigger a notification on this device.',
  'settings.pushAll': 'All messages',
  'settings.pushMentions': 'Mentions and direct messages',
  'settings.pushNone': 'None',
  'settings.pushNotFound': 'Notification preference not found.',
  'settings.saveFailed': "Couldn't save — try again.",
  'settings.sectionLanguage': 'Language',
  'settings.languageHelp': 'The app language.',
  'settings.sectionAccount': 'Account',
  'settings.signedIn': 'Signed in',
  'settings.server': 'Server',
  'settings.sectionDiagnostics': 'Diagnostics',
  'settings.getToken': 'Get the FCM token',
  'settings.switchServer': 'Change server',
  'settings.signOut': 'Sign out',

  'messageRow.profileOf': 'Profile of {name}',
  'messageRow.edited': '(edited)',
  'messageRow.sending': '⏳ sending…',
  'messageRow.replies': '{n} reply | {n} replies',
  'messageRow.failedRetry': '⚠️ Failed — retry',
  'messageRow.discard': 'discard',
  'messageRow.encrypted': '🔒 Encrypted message, not supported',
  'messageRow.emptyMessage': '(empty message)',
  'messageRow.videoCall': '📞 Video call',
  'messageRow.joinCall': 'Join the call',
  'messageRow.join': 'Join',
  'messageRow.imageEnlarge': 'Image, tap to enlarge',
  'messageRow.file': 'File',
  'messageRow.fileUnreadable': '🔒 Encrypted file could not be read',
  'messageRow.fileOpenFailed': 'Cannot open this file.',

  'login.title': 'Sign in',
  'login.tagline': 'Your magical little chat corner ✨',
  'login.serverAddress': 'Server address',
  'login.continue': 'Continue',
  'login.knownServers': 'Known servers',
  'login.usernameOrEmail': 'Username or email',
  'login.usernameExample': 'jane.doe',
  'login.password': 'Password',
  'login.signIn': 'Sign in',
  'login.switchServer': 'Change server',
  'login.noPasswordLogin': 'This server does not offer password sign-in.',
  'login.serverUnreachable': 'Server unreachable.',
  'login.credentialsRejected': 'Username or password rejected.',
  'login.signInFailed': 'Sign-in failed.',
  'login.codeRejected': 'Code rejected. Try again.',
  'login.codePrepareFailed': "Couldn't prepare the code.",
  'login.codeSendFailed': "Couldn't send the code.",
  'login.networkHelp':
    "From the emulator: `adb reverse tcp:3000 tcp:3000`. From a phone: the machine's LAN IP.",
  'login.magicVerification': 'Magic verification',
  'login.introEmail': 'This account is protected by a code sent via email.',
  'login.sendCode': 'Send me the code',
  'login.labelTotp': 'Authenticator app code',
  'login.labelEmail': 'Code received by email',
  'login.labelPassword': 'Confirm your password',
  'login.introPassword': 'Re-enter your password to confirm.',
  'login.introTotp': 'Enter the code from your\nauthenticator app ✨',
  'login.submit': 'Confirm',
  'login.resendCode': 'Resend the code',

  'room.newMessages': '✦ new messages',
  'room.jumpToLatest': 'Jump to latest messages',
  'room.marked': 'Pinned and starred messages',
  'room.jumpFailed': 'Message not found in recent history.',
  'daySeparator.today': 'Today',
  'daySeparator.yesterday': 'Yesterday',
  'room.noMessages': 'No messages.',
  'room.typingOne': '{name} is typing…',
  'room.typingTwo': '{a} and {b} are typing…',
  'room.typingN': '{n} people are typing…',
  'room.fileNotSent': '⚠️ {name} not sent',
  'room.filePending': '⏳ {name} waiting to send',
  'room.fileSending': '⬆️ {name} — {percent}%',
  'room.threadReplyNotSent': '⚠️ Thread reply not sent — open',
  'room.retry': 'retry',
  'room.discard': 'discard',
  'room.encryptedLocked': '🔓 Unlock to read this encrypted channel',
  'e2e.title': 'Unlock encryption',
  'e2e.explanation':
    'Enter your E2E encryption password to read encrypted channels. It unlocks this device once and for all.',
  'e2e.field': 'E2E password',
  'e2e.unlock': 'Unlock',
  'e2e.wrongPassword': 'Incorrect password.',
  'e2e.genericError': 'Could not unlock.',
  'settings.e2eTitle': 'End-to-end encryption',
  'settings.e2eLocked': 'Locked — encrypted channels are unreadable',
  'settings.e2eUnlocked': 'Unlocked on this device',
  'settings.e2eUnlock': 'Unlock…',
  'settings.e2eLock': 'Lock',
  'room.readOnly': 'This channel is read-only.',
  'room.privateNote': 'Only you can see this',
  'room.commandRejected': 'Command refused: {error}',
  'room.uploadFailed': 'Upload failed.',
  'room.microphoneDenied': 'Microphone access denied.',
  'room.recordingEmpty': 'Empty recording.',
  'room.recordingFailed': 'Recording failed.',
  'room.cameraDenied': 'Camera access denied.',
  'room.selectionFailed': 'Selection failed.',
  'room.pickerStuck': 'The picker stopped responding. Close the app and reopen it.',
  'room.attachFile': 'Attach a file',
  'room.backToKeyboard': 'Back to keyboard',
  'room.pickEmoji': 'Choose an emoji',
  'room.addCaption': 'Add a caption…',
  'room.messagePlaceholder': 'Message',
  'room.stopRecording': 'Stop recording',
  'room.voiceMessage': 'Voice message',
  'room.callTitle': 'Call',
  'room.callStartFailed': "Couldn't start the call for this channel.",
  'room.back': 'Back',
  'room.conversationInfo': 'Conversation info',
  'room.startCall': 'Start a video call',
  'room.replyingTo': 'Replying to {name}',
  'room.cancelReply': 'Cancel reply',
  'room.otherServerTitle': 'This message is on another server',
  'room.otherServerBody': 'It comes from {host}.',
  'room.otherServerButton': 'Switch to that server',
  'room.otherServerFailed': 'No session stored for that server.',

  'sys.uj': 'joined the channel',
  'sys.ujt': 'joined the team',
  'sys.ul': 'left the channel',
  'sys.ult': 'left the team',
  'sys.ru': 'removed {p} from the channel',
  'sys.au': 'added {p} to the channel',
  'sys.r': 'renamed the channel to {p}',
  'sys.rm': '(message removed)',
  'sys.wmEmpty': 'welcome!',
  'sys.wm': 'welcome, {p}!',
  'sys.uploaded': 'sent the file {p}',
  'sys.messagePinned': 'pinned a message',
  'sys.messageUnpinned': 'unpinned a message',
  'sys.topicRemoved': 'removed the topic',
  'sys.topic': 'changed the topic: {p}',
  'sys.announcementRemoved': 'removed the announcement',
  'sys.announcement': 'changed the announcement: {p}',
  'sys.descriptionRemoved': 'removed the description',
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
  'sys.unknown': '(system action “{type}”)',
  'sys.unknownWithParam': '(system action “{type}”: {p})',

  'home.settings': 'Settings',
  'home.sectionUnread': 'Unread',
  'home.sectionFavorites': 'Favorites',
  'home.sectionRooms': 'Channels',
  'home.sectionDirectMessages': 'Direct messages',
  'home.sectionConversations': '{n} conversation | {n} conversations',
  'home.emptyList': 'No channels yet — the first sync may take a few seconds.',
  'home.encryptedMessages': 'Encrypted messages',
  'home.callPreview': 'Video call',
  'home.newConversation': 'New conversation',

  'search.title': 'New conversation',
  'search.placeholder': 'User or channel…',
  'search.searchFailed': 'Search failed.',
  'search.conversationFailed': "Couldn't start the conversation.",
  'search.joinFailed': "Couldn't join.",
  'search.noResults': 'No results.',

  'messageSearch.title': 'Search the channel',
  'messageSearch.placeholder': 'Search messages…',
  'messageSearch.searchFailed': 'Search failed.',
  'messageSearch.noMessages': 'No messages found.',

  'marked.title': 'Pinned and starred',
  'marked.pinned': 'Pinned',
  'marked.starred': 'Starred',
  'marked.noPinned': 'No pinned messages.',
  'marked.noStarred': 'No starred messages.',
  'marked.loadFailed': "Couldn't load.",

  'thread.title': 'Thread',
  'thread.notFound': 'Thread not found.',
  'thread.reply': 'Reply in thread',

  'messageActions.messageNotFound': 'Message not found.',
  'messageActions.noActions': 'Nothing to do with this message.',
  'messageActions.loadFailed': "Couldn't load.",
  'messageActions.actionRejected': 'Action refused.',
  'messageActions.reply': 'Reply',
  'messageActions.replyInThread': 'Reply in thread',
  'messageActions.copy': 'Copy',
  'messageActions.share': 'Share',
  'messageActions.save': 'Download',
  'saved.gallery': 'Saved to gallery',
  'saved.downloads': 'Saved to Downloads',
  'saved.failed': "Couldn't save this file.",
  'messageActions.edit': 'Edit',
  'messageActions.pin': 'Pin',
  'messageActions.unpin': 'Unpin',
  'messageActions.star': 'Star',
  'messageActions.unstar': 'Unstar',

  'attach.photo': 'Take a photo',
  'attach.video': 'Record a video',
  'attach.library': 'Choose from library',
  'attach.file': 'Choose a file',

  'share.title': 'Share',
  'share.signInFirst': 'Sign in to share to a conversation.',
  'share.shareFailed': "Couldn't share.",
  'share.addCaption': 'Add a caption…',
  'share.messageToShare': 'Message to share',
  'share.shareTo': 'Share to',
  'share.searchConversation': 'Search for a conversation…',
  'share.noConversations': 'No conversations.',
  'share.encrypted': '🔒 Encrypted',
  'share.readOnly': 'Read-only',
  'share.removeAttachment': 'Remove attachment',

  'call.videoCall': 'Video call',
  'call.joinFailed': "Couldn't join the call. It may have ended.",
  'call.endCall': 'End the call',
  'call.end': 'End',
  'call.connecting': 'Connecting to the call…',
  'call.loadFailed': "The call couldn't load.",

  'emojiPicker.search': 'Search for an emoji',
  'emojiPicker.clearSearch': 'Clear search',
  'emojiPicker.empty': 'No emoji',
  'emojiPicker.custom': 'Custom',
  'emojiPicker.people': 'Smileys & people',
  'emojiPicker.nature': 'Animals & nature',
  'emojiPicker.food': 'Food & drink',
  'emojiPicker.activity': 'Activities',
  'emojiPicker.travel': 'Travel & places',
  'emojiPicker.objects': 'Objects',
  'emojiPicker.symbols': 'Symbols',
  'emojiPicker.flags': 'Flags',

  'audioPlayer.voiceMessage': 'Voice message',
  'audioPlayer.play': 'Play voice message',
  'audioPlayer.pause': 'Pause',
  'videoPlayer.video': 'Video',
  'videoPlayer.play': 'Video, tap to play',
  'videoPlayer.playWithTitle': 'Video: {title}, tap to play',
  'viewer.image': 'Image',

  'attachmentPreview.image': 'Image',
  'attachmentPreview.file': 'File',
  'attachmentPreview.remove': 'Remove attachment',
  'attachmentPreview.bytes': '{size} B',
  'attachmentPreview.kilobytes': '{size} KB',
  'attachmentPreview.megabytes': '{size} MB',
  'attachmentPreview.reduced': 'Reduced',
  'attachmentPreview.original': 'Original',
  'attachmentPreview.sendReduced': 'Send in reduced quality',
  'attachmentPreview.sendOriginal': 'Send in original quality',
  'attachmentPreview.preview': 'Preview {name}',
  'attachmentPreview.openFailed': "Couldn't open this file.",

  'linkCard.imageEnlarge': 'Image, tap to enlarge',
  'linkCard.defaultLink': 'Link',
  'linkCard.open': '{name}, tap to open',
  'embedCard.open': '{name}, tap to open',

  'notifications.encryptedTitle': 'Encrypted message',
  'notifications.encryptedBody': 'New message in an encrypted channel.',

  'sync.databaseUnavailable': 'Local database unavailable.',

  'myProfile.title': 'My profile',
  'myProfile.profileUnreadable': 'Profile unreadable.',
  'myProfile.selectionFailed': 'Selection failed.',
  'myProfile.nothingToSave': 'Nothing to save.',
  'myProfile.passwordRequired': 'Your current password is required to change your email or username.',
  'myProfile.profileSaved': 'Profile saved ✨',
  'myProfile.codeRejected': 'Code rejected. Try again.',
  'myProfile.saveFailed': 'Could not save.',
  'myProfile.codePrepareFailed': 'Could not prepare the code.',
  'myProfile.changePhotoLabel': 'Change profile photo',
  'myProfile.changePhoto': 'Change photo',
  'myProfile.sectionPresence': 'Presence',
  'myProfile.labelStatus': 'Status text',
  'myProfile.placeholderStatus': 'On vacation ✨',
  'myProfile.sectionProfile': 'Profile',
  'myProfile.labelName': 'Display name',
  'myProfile.placeholderName': 'Your name',
  'myProfile.labelBio': 'Bio',
  'myProfile.placeholderBio': 'A few words about you',
  'myProfile.sectionAccount': 'Account',
  'myProfile.accountHelp':
    'Changing your email or username requires your current password — and sometimes a verification code.',
  'myProfile.labelEmail': 'Email address',
  'myProfile.placeholderEmail': 'you@example.com',
  'myProfile.labelUsername': 'Username',
  'myProfile.placeholderUsername': 'username',
  'myProfile.labelPassword': 'Current password',
  'myProfile.verificationRequired': 'Verification required',
  'myProfile.help2faTotp': 'Enter the code from your authenticator app.',
  'myProfile.help2faEmail': 'Enter the code that was just sent to you by email.',
  'myProfile.help2faPassword': 'Re-enter your password to confirm.',
  'myProfile.labelCode': 'Code',
  'myProfile.submitCode': 'Submit code',

  'profile.profileUnreadable': 'Profile unreadable.',
  'profile.profileNotFound': 'Profile not found.',
  'profile.actionFailed': 'Action failed.',
  'profile.localTime': 'Local time: {time}',
  'profile.sendMessageLabel': 'Send a message to {name}',
  'profile.messageButton': '💬 Message',
  'profile.callLabel': 'Call {name}',
  'profile.callButton': '📞 Call',

  'roomInfo.typePublicChannel': 'Public channel',
  'roomInfo.typePrivateGroup': 'Private group',
  'roomInfo.typeDirectMessage': 'Direct message',
  'roomInfo.members': '{n} member | {n} members',
  'roomInfo.encrypted': 'encrypted',
  'roomInfo.readOnly': 'read-only',
  'roomInfo.detailsUnavailable': 'Details unavailable.',
  'roomInfo.announcement': 'Announcement',
  'roomInfo.topic': 'Topic',
  'roomInfo.description': 'Description',
  'roomInfo.nothingSet': 'No description, topic, or announcement.',
  'roomInfo.addFavorite': 'Add to favorites',
  'roomInfo.removeFavorite': 'Remove from favorites',
  'roomInfo.favoriteFailed': 'Favorite not changed: try again.',
};

/** Les deux catalogues, prêts à l'indexation par langue. */
export const CATALOGUES = { fr, en } as const;

/** Langues disponibles — dérivées des catalogues, jamais désynchronisées. */
export type Language = keyof typeof CATALOGUES;
export const LANGUAGES = Object.keys(CATALOGUES) as readonly Language[];

/** Préférence stockée : une langue explicite, ou « suivre l'appareil ». */
export type LanguagePreference = Language | 'auto';

/**
 * Noms de langue en ENDONYME (dans la langue elle-même) : « Français » et
 * « English » se lisent pareil quelle que soit la langue de l'interface —
 * convention des sélecteurs de langue.
 */
export const LANGUAGE_NAMES: Record<Language, string> = {
  fr: 'Français',
  en: 'English',
};

export type TranslationParams = Record<string, string | number>;
export type TranslateFn = (key: TranslationKey, params?: TranslationParams) => string;

/**
 * Langue du téléphone, en PUR JS : Hermes (RN 0.86) embarque `Intl`/ICU adossé
 * à `Locale.getDefault()` d'Android. Aucun module natif — donc pas de rebuild du
 * dev-client ni de dépendance à justifier (ROADMAP §4.2) — et ça tourne tel quel
 * sous Node. Repli sur l'anglais pour toute locale non couverte (défaut
 * international neutre).
 */
export function deviceLanguage(): Language {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subTag = locale.split(/[-_]/)[0]?.toLowerCase();
  return subTag === 'fr' ? 'fr' : 'en';
}

/**
 * Formateur d'heure des messages, lié à une LANGUE — pas à la locale de
 * l'appareil : l'heure suit la langue choisie dans les paramètres, comme toute
 * chaîne du catalogue. FR « 14:05 » (2-digit), EN « 2:05 PM » (numeric — le
 * 2-digit anglophone donnerait « 02:05 PM », que personne n'écrit). Fabrique à
 * mémoïser par l'appelant : construire un `Intl.DateTimeFormat` coûte cher,
 * `format` non (cf. `useHeure`, ui/i18n.ts).
 */
export function timeFormatter(language: Language): (ms: number) => string {
  const format = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', {
    hour: language === 'fr' ? '2-digit' : 'numeric',
    minute: '2-digit',
  });
  return (ms) => format.format(new Date(ms));
}

/**
 * Libellé d'un séparateur de jour (ui/daySeparator) : « Aujourd'hui »,
 * « Hier », sinon la date — avec le jour de semaine dans l'année courante
 * (« jeudi 31 juillet »), avec l'année au-delà (« 31 juillet 2025 », le jour
 * de semaine n'aide plus à se situer si loin). Même fabrique à mémoïser que
 * `formateurHeure`. `maintenantMs` est lu à CHAQUE appel (une liste ouverte à
 * travers minuit re-rend « Aujourd'hui » juste) ; injectable pour les tests.
 */
export function dayFormatter(language: Language): (ms: number, nowMs?: number) => string {
  const locale = language === 'fr' ? 'fr-FR' : 'en-US';
  const sameYear = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const otherYear = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  return (ms, nowMs = Date.now()) => {
    const now = new Date(nowMs);
    const day = dayKey(ms);
    if (day === dayKey(nowMs)) return translate(language, 'daySeparator.today');
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (day === dayKey(yesterday.getTime())) return translate(language, 'daySeparator.yesterday');
    const date = new Date(ms);
    return date.getFullYear() === now.getFullYear()
      ? sameYear.format(date)
      : otherYear.format(date);
  };
}

/**
 * Sélection singulier/pluriel. FR : singulier pour 0 et 1 (« 0 membre »,
 * « 1 membre »), pluriel dès 2. EN : singulier pour 1 seulement.
 */
function isPlural(language: Language, n: number): boolean {
  return language === 'fr' ? n > 1 : n !== 1;
}

/**
 * Rend le modèle final : d'abord le choix du pluriel (`singulier | pluriel`
 * arbitré par le paramètre numérique `n`), puis la substitution des `{param}`.
 * Un `{param}` sans valeur est laissé TEL QUEL — plus parlant qu'un « undefined »
 * en pleine phrase pour repérer un oubli d'argument.
 */
function interpolate(
  template: string,
  params: TranslationParams | undefined,
  language: Language,
): string {
  let s = template;
  if (s.includes(' | ') && typeof params?.n === 'number') {
    const [singular, plural] = s.split(' | ');
    s = (isPlural(language, params.n) ? plural : singular) ?? s;
  }
  if (params === undefined) return s;
  return s.replace(/\{(\w+)\}/g, (raw, key: string) =>
    key in params ? String(params[key]) : raw,
  );
}

/**
 * Traduit une clé dans une langue. Repli sur le français (la référence) si une
 * clé venait à manquer côté cible — impossible en théorie (le type l'interdit),
 * mais un texte français reste préférable à une clé brute affichée.
 */
export function translate(
  language: Language,
  key: TranslationKey,
  params?: TranslationParams,
): string {
  const template = CATALOGUES[language][key] ?? CATALOGUES.fr[key];
  return interpolate(template, params, language);
}
