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
  'commun.pieceJointe': 'Pièce jointe',
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
  'ligneMessage.fichierOuvertureEchouee': "Impossible d'ouvrir ce fichier.",

  // ── Connexion (serveur → identifiants → second facteur)
  'connexion.titre': 'Connexion',
  'connexion.slogan': 'Ton coin de chat magique ✨',
  'connexion.adresseServeur': 'Adresse du serveur',
  'connexion.continuer': 'Continuer',
  'connexion.serveursConnus': 'Serveurs connus',
  'connexion.identifiantOuEmail': 'Identifiant ou email',
  'connexion.exempleIdentifiant': 'jean.dupont',
  'connexion.motDePasse': 'Mot de passe',
  'connexion.seConnecter': 'Se connecter',
  'connexion.changerServeur': 'Changer de serveur',
  'connexion.sansMotDePasse': 'Ce serveur ne propose pas la connexion par mot de passe.',
  'connexion.serveurInjoignable': 'Serveur injoignable.',
  'connexion.identifiantsRefuses': 'Identifiant ou mot de passe refusé.',
  'connexion.connexionImpossible': 'Connexion impossible.',
  'connexion.codeRefuse': 'Code refusé. Réessaie.',
  'connexion.preparationCodeImpossible': 'Préparation du code impossible.',
  'connexion.envoiCodeImpossible': "Impossible d'envoyer le code.",
  'connexion.aideReseau':
    "Depuis l'émulateur : `adb reverse tcp:3000 tcp:3000`. Depuis un téléphone : l'IP LAN de la machine.",
  'connexion.verificationMagique': 'Vérification magique',
  'connexion.introEmail': 'Ce compte est protégé par un code envoyé par email.',
  'connexion.envoyerLeCode': "M'envoyer le code",
  'connexion.etiquetteTotp': "Code de l'application d'authentification",
  'connexion.etiquetteEmail': 'Code reçu par email',
  'connexion.etiquettePassword': 'Confirme ton mot de passe',
  'connexion.introPassword': 'Ressaisis ton mot de passe pour confirmer.',
  'connexion.introTotp': "Entre le code de ton application\nd'authentification ✨",
  'connexion.valider': 'Valider',
  'connexion.renvoyerCode': 'Renvoyer le code',

  // ── Salon (écran d'un salon : liste + composer + en-tête)
  'salon.presenceOnline': 'en ligne',
  'salon.presenceAway': 'absent',
  'salon.presenceBusy': 'occupé',
  'salon.presenceOffline': 'hors ligne',
  'salon.nouveauxMessages': '✦ nouveaux messages',
  'salon.aucunMessage': 'Aucun message.',
  'salon.fichierNonEnvoye': '⚠️ {nom} non envoyé',
  'salon.reponseFilNonEnvoyee': '⚠️ Réponse de fil non envoyée — ouvrir',
  'salon.reessayer': 'réessayer',
  'salon.abandonner': 'abandonner',
  'salon.chiffre':
    '🔒 Salon chiffré de bout en bout — écriture non prise en charge par cette application.',
  'salon.chiffreVerrouille': '🔓 Déverrouiller pour lire ce salon chiffré',
  'salon.chiffreLecture': '🔒 Chiffré — lecture seule (envoi non pris en charge)',
  'e2e.titre': 'Déverrouiller le chiffrement',
  'e2e.explication':
    'Entre ton mot de passe de chiffrement E2E pour lire les salons chiffrés. Il déverrouille cet appareil une fois pour toutes.',
  'e2e.champ': 'Mot de passe E2E',
  'e2e.deverrouiller': 'Déverrouiller',
  'e2e.erreurMotDePasse': 'Mot de passe incorrect.',
  'e2e.erreurGenerique': 'Déverrouillage impossible.',
  'parametres.e2eTitre': 'Chiffrement de bout en bout',
  'parametres.e2eVerrouille': 'Verrouillé — les salons chiffrés sont illisibles',
  'parametres.e2eDeverrouille': 'Déverrouillé sur cet appareil',
  'parametres.e2eDeverrouiller': 'Déverrouiller…',
  'parametres.e2eVerrouiller': 'Verrouiller',
  'salon.lectureSeule': 'Ce salon est en lecture seule.',
  'salon.televersementImpossible': 'Téléversement impossible.',
  'salon.microRefuse': 'Accès au micro refusé.',
  'salon.enregistrementVide': 'Enregistrement vide.',
  'salon.enregistrementImpossible': 'Enregistrement impossible.',
  'salon.cameraRefuse': 'Accès à la caméra refusé.',
  'salon.selectionImpossible': 'Sélection impossible.',
  // Le NPE d'arbre de vues d'Android : rien dans l'app n'en sort, seul un
  // redémarrage le solde. Autant le dire clairement (voir `lancerSelecteur.ts`).
  'salon.selecteurBloque': "Le sélecteur ne répond plus. Fermez l'app et rouvrez-la.",
  'salon.joindreFichier': 'Joindre un fichier',
  'salon.revenirClavier': 'Revenir au clavier',
  'salon.choisirEmoji': 'Choisir un emoji',
  'salon.ajouterLegende': 'Ajouter une légende…',
  'salon.messagePlaceholder': 'Message',
  'salon.arreterEnregistrement': "Arrêter l'enregistrement",
  'salon.messageVocal': 'Message vocal',
  'salon.appelTitre': 'Appel',
  'salon.appelImpossibleDemarrer': "Impossible de démarrer l'appel pour ce salon.",
  'salon.retour': 'Retour',
  'salon.infosConversation': 'Informations de la conversation',
  'salon.demarrerAppel': 'Démarrer un appel vidéo',
  'salon.reponseA': 'Réponse à {nom}',
  'salon.annulerReponse': 'Annuler la réponse',

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

  // ── Accueil (liste des conversations)
  'accueil.parametres': 'Paramètres',
  'accueil.sectionNonLus': 'Non lus',
  'accueil.sectionSalons': 'Salons',
  'accueil.sectionMessagesPrives': 'Messages privés',
  'accueil.listeVide':
    "Aucun salon pour l'instant — la première synchronisation peut prendre quelques secondes.",
  'accueil.messagesChiffres': 'Messages chiffrés',
  // Aperçu d'un salon dont le dernier message est un appel vidéo : il n'a
  // aucun texte, son contenu vit dans ses `blocks`.
  'accueil.apercuAppel': 'Appel vidéo',
  'accueil.nouvelleConversation': 'Nouvelle conversation',

  // ── Recherche (nouvelle conversation)
  'recherche.titre': 'Nouvelle conversation',
  'recherche.placeholder': 'Utilisateur ou canal…',
  'recherche.rechercheImpossible': 'Recherche impossible.',
  'recherche.conversationImpossible': 'Conversation impossible.',
  'recherche.rejoindreImpossible': 'Impossible de rejoindre.',
  'recherche.aucunResultat': 'Aucun résultat.',

  // ── Recherche dans le salon
  'rechercheMessages.titre': 'Rechercher dans le salon',
  'rechercheMessages.placeholder': 'Rechercher des messages…',
  'rechercheMessages.rechercheImpossible': 'Recherche impossible.',
  'rechercheMessages.aucunMessage': 'Aucun message trouvé.',

  // ── Fil de discussion
  'fil.titre': 'Fil',
  'fil.introuvable': 'Fil introuvable.',
  'fil.chiffre':
    '🔒 Salon chiffré de bout en bout — écriture non prise en charge par cette application.',
  'fil.lectureSeule': 'Ce salon est en lecture seule.',
  'fil.revenirClavier': 'Revenir au clavier',
  'fil.choisirEmoji': 'Choisir un emoji',
  'fil.repondre': 'Répondre dans le fil',

  // ── Actions sur un message
  'actionsMessage.messageIntrouvable': 'Message introuvable.',
  'actionsMessage.aucuneAction': 'Rien à faire sur ce message.',
  'actionsMessage.chargementImpossible': 'Chargement impossible.',
  'actionsMessage.actionRefusee': 'Action refusée.',
  'actionsMessage.repondre': 'Répondre',
  'actionsMessage.modifier': 'Modifier',
  'actionsMessage.epingler': 'Épingler',

  // ── Joindre (menu de sources)
  'joindre.photo': 'Prendre une photo',
  'joindre.video': 'Prendre une vidéo',
  'joindre.bibliotheque': 'Choisir dans la bibliothèque',
  'joindre.fichier': 'Choisir un fichier',

  // ── Partage entrant (ACTION_SEND)
  'partager.titre': 'Partager',
  'partager.connecteToi': 'Connecte-toi pour partager dans une conversation.',
  'partager.partageImpossible': 'Partage impossible.',
  'partager.ajouterLegende': 'Ajouter une légende…',
  'partager.messageAPartager': 'Message à partager',
  'partager.partagerVers': 'Partager vers',
  'partager.rechercherConversation': 'Rechercher une conversation…',
  'partager.aucuneConversation': 'Aucune conversation.',
  'partager.chiffre': '🔒 Chiffré',
  'partager.lectureSeule': 'Lecture seule',
  'partager.retirerPieceJointe': 'Retirer la pièce jointe',

  // ── Appel vidéo (WebView Jitsi)
  'appel.appelVideo': 'Appel vidéo',
  'appel.impossibleRejoindre': "Impossible de rejoindre l'appel. Il est peut-être terminé.",
  'appel.terminerAppel': "Terminer l'appel",
  'appel.terminer': 'Terminer',
  'appel.connexion': 'Connexion à l’appel…',
  'appel.chargementEchoue': "L'appel n'a pas pu se charger.",

  // ── Navigateur d'emojis
  'navigateurEmoji.rechercher': 'Rechercher un emoji',
  'navigateurEmoji.effacerRecherche': 'Effacer la recherche',
  'navigateurEmoji.vide': 'Aucun emoji',
  'navigateurEmoji.personnalises': 'Personnalisés',
  'navigateurEmoji.people': 'Émotions',
  'navigateurEmoji.nature': 'Animaux et nature',
  'navigateurEmoji.food': 'Nourriture et boissons',
  'navigateurEmoji.activity': 'Activités',
  'navigateurEmoji.travel': 'Voyage et lieux',
  'navigateurEmoji.objects': 'Objets',
  'navigateurEmoji.symbols': 'Symboles',
  'navigateurEmoji.flags': 'Drapeaux',

  // ── Lecteurs média
  'lecteurAudio.messageVocal': 'Message vocal',
  'lecteurAudio.lire': 'Lire le message vocal',
  'lecteurAudio.pause': 'Pause',
  'lecteurVideo.video': 'Vidéo',
  'lecteurVideo.lire': 'Vidéo, toucher pour lire',
  'lecteurVideo.lireAvecTitre': 'Vidéo : {titre}, toucher pour lire',
  'visionneuse.image': 'Image',

  // ── Aperçu de pièce jointe
  'apercuPieceJointe.image': 'Image',
  'apercuPieceJointe.fichier': 'Fichier',
  'apercuPieceJointe.retirer': 'Retirer la pièce jointe',
  'apercuPieceJointe.octets': '{taille} o',
  'apercuPieceJointe.kilooctets': '{taille} Ko',
  'apercuPieceJointe.megaoctets': '{taille} Mo',

  // ── Cartes (aperçus de liens / embeds)
  'carteLien.imageAgrandir': 'Image, toucher pour agrandir',
  'carteLien.lienDefaut': 'Lien',
  'carteLien.ouvrir': '{nom}, toucher pour ouvrir',
  'carteEmbed.ouvrir': '{nom}, toucher pour ouvrir',

  // ── Notifications (contenu masqué d'un salon chiffré)
  'notifications.titreChiffre': 'Message chiffré',
  'notifications.corpsChiffre': 'Nouveau message dans un salon chiffré.',

  // ── Synchro
  'synchro.baseInutilisable': 'Base locale inutilisable.',

  // ── Mon profil (édition)
  'monProfil.titre': 'Mon profil',
  'monProfil.presenceEnLigne': 'En ligne',
  'monProfil.presenceAbsent': 'Absent',
  'monProfil.presenceOccupe': 'Occupé',
  'monProfil.presenceHorsLigne': 'Hors ligne',
  'monProfil.profilIllisible': 'Profil illisible.',
  'monProfil.selectionImpossible': 'Sélection impossible.',
  'monProfil.rienAEnregistrer': 'Rien à enregistrer.',
  'monProfil.mdpRequis':
    'Ton mot de passe actuel est requis pour changer l’e-mail ou le nom d’utilisateur.',
  'monProfil.profilEnregistre': 'Profil enregistré ✨',
  'monProfil.codeRefuse': 'Code refusé. Réessaie.',
  'monProfil.enregistrementImpossible': 'Enregistrement impossible.',
  'monProfil.preparationCodeImpossible': 'Préparation du code impossible.',
  'monProfil.changerPhotoLabel': 'Changer la photo de profil',
  'monProfil.changerPhoto': 'Changer la photo',
  'monProfil.sectionPresence': 'Présence',
  'monProfil.etiquetteStatut': 'Texte de statut',
  'monProfil.placeholderStatut': 'En vacances ✨',
  'monProfil.sectionProfil': 'Profil',
  'monProfil.etiquetteNom': 'Nom affiché',
  'monProfil.placeholderNom': 'Ton nom',
  'monProfil.etiquetteBio': 'Bio',
  'monProfil.placeholderBio': 'Quelques mots sur toi',
  'monProfil.sectionCompte': 'Compte',
  'monProfil.aideCompte':
    'Changer l’e-mail ou le nom d’utilisateur demande ton mot de passe actuel — et parfois un code de vérification.',
  'monProfil.etiquetteEmail': 'Adresse e-mail',
  'monProfil.placeholderEmail': 'toi@exemple.fr',
  'monProfil.etiquetteUsername': 'Nom d’utilisateur',
  'monProfil.placeholderUsername': 'pseudo',
  'monProfil.etiquetteMdp': 'Mot de passe actuel',
  'monProfil.verificationRequise': 'Vérification requise',
  'monProfil.aide2faTotp': 'Entre le code de ton application d’authentification.',
  'monProfil.aide2faEmail': 'Entre le code qui vient de t’être envoyé par e-mail.',
  'monProfil.aide2faMdp': 'Ressaisis ton mot de passe pour confirmer.',
  'monProfil.etiquetteCode': 'Code',
  'monProfil.validerCode': 'Valider le code',

  // ── Fiche d'un utilisateur
  'profil.presenceEnLigne': 'en ligne',
  'profil.presenceAbsent': 'absent',
  'profil.presenceOccupe': 'occupé',
  'profil.presenceHorsLigne': 'hors ligne',
  'profil.profilIllisible': 'Profil illisible.',
  'profil.profilIntrouvable': 'Profil introuvable.',
  'profil.conversationImpossible': 'Conversation impossible.',
  'profil.actionImpossible': 'Action impossible.',
  'profil.heureLocale': 'Heure locale : {heure}',
  'profil.envoyerMessageLabel': 'Envoyer un message à {nom}',
  'profil.boutonMessage': '💬 Message',
  'profil.appelerLabel': 'Appeler {nom}',
  'profil.boutonAppeler': '📞 Appeler',

  // ── Fiche d'un salon
  'salonInfo.typeCanalPublic': 'Canal public',
  'salonInfo.typeGroupePrive': 'Groupe privé',
  'salonInfo.typeMessageDirect': 'Message direct',
  'salonInfo.membres': '{n} membre | {n} membres',
  'salonInfo.chiffre': 'chiffré',
  'salonInfo.lectureSeule': 'lecture seule',
  'salonInfo.detailsIndisponibles': 'Détails indisponibles.',
  'salonInfo.annonce': 'Annonce',
  'salonInfo.sujet': 'Sujet',
  'salonInfo.description': 'Description',
  'salonInfo.rienARenseigner': 'Ni description, ni sujet, ni annonce.',
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
  'commun.pieceJointe': 'Attachment',
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
  'ligneMessage.fichierOuvertureEchouee': 'Cannot open this file.',

  'connexion.titre': 'Sign in',
  'connexion.slogan': 'Your magical little chat corner ✨',
  'connexion.adresseServeur': 'Server address',
  'connexion.continuer': 'Continue',
  'connexion.serveursConnus': 'Known servers',
  'connexion.identifiantOuEmail': 'Username or email',
  'connexion.exempleIdentifiant': 'jane.doe',
  'connexion.motDePasse': 'Password',
  'connexion.seConnecter': 'Sign in',
  'connexion.changerServeur': 'Change server',
  'connexion.sansMotDePasse': 'This server does not offer password sign-in.',
  'connexion.serveurInjoignable': 'Server unreachable.',
  'connexion.identifiantsRefuses': 'Username or password rejected.',
  'connexion.connexionImpossible': 'Sign-in failed.',
  'connexion.codeRefuse': 'Code rejected. Try again.',
  'connexion.preparationCodeImpossible': "Couldn't prepare the code.",
  'connexion.envoiCodeImpossible': "Couldn't send the code.",
  'connexion.aideReseau':
    "From the emulator: `adb reverse tcp:3000 tcp:3000`. From a phone: the machine's LAN IP.",
  'connexion.verificationMagique': 'Magic verification',
  'connexion.introEmail': 'This account is protected by a code sent via email.',
  'connexion.envoyerLeCode': 'Send me the code',
  'connexion.etiquetteTotp': 'Authenticator app code',
  'connexion.etiquetteEmail': 'Code received by email',
  'connexion.etiquettePassword': 'Confirm your password',
  'connexion.introPassword': 'Re-enter your password to confirm.',
  'connexion.introTotp': 'Enter the code from your\nauthenticator app ✨',
  'connexion.valider': 'Confirm',
  'connexion.renvoyerCode': 'Resend the code',

  'salon.presenceOnline': 'online',
  'salon.presenceAway': 'away',
  'salon.presenceBusy': 'busy',
  'salon.presenceOffline': 'offline',
  'salon.nouveauxMessages': '✦ new messages',
  'salon.aucunMessage': 'No messages.',
  'salon.fichierNonEnvoye': '⚠️ {nom} not sent',
  'salon.reponseFilNonEnvoyee': '⚠️ Thread reply not sent — open',
  'salon.reessayer': 'retry',
  'salon.abandonner': 'discard',
  'salon.chiffre':
    '🔒 End-to-end encrypted channel — writing is not supported by this app.',
  'salon.chiffreVerrouille': '🔓 Unlock to read this encrypted channel',
  'salon.chiffreLecture': '🔒 Encrypted — read-only (sending not supported)',
  'e2e.titre': 'Unlock encryption',
  'e2e.explication':
    'Enter your E2E encryption password to read encrypted channels. It unlocks this device once and for all.',
  'e2e.champ': 'E2E password',
  'e2e.deverrouiller': 'Unlock',
  'e2e.erreurMotDePasse': 'Incorrect password.',
  'e2e.erreurGenerique': 'Could not unlock.',
  'parametres.e2eTitre': 'End-to-end encryption',
  'parametres.e2eVerrouille': 'Locked — encrypted channels are unreadable',
  'parametres.e2eDeverrouille': 'Unlocked on this device',
  'parametres.e2eDeverrouiller': 'Unlock…',
  'parametres.e2eVerrouiller': 'Lock',
  'salon.lectureSeule': 'This channel is read-only.',
  'salon.televersementImpossible': 'Upload failed.',
  'salon.microRefuse': 'Microphone access denied.',
  'salon.enregistrementVide': 'Empty recording.',
  'salon.enregistrementImpossible': 'Recording failed.',
  'salon.cameraRefuse': 'Camera access denied.',
  'salon.selectionImpossible': 'Selection failed.',
  'salon.selecteurBloque': 'The picker stopped responding. Close the app and reopen it.',
  'salon.joindreFichier': 'Attach a file',
  'salon.revenirClavier': 'Back to keyboard',
  'salon.choisirEmoji': 'Choose an emoji',
  'salon.ajouterLegende': 'Add a caption…',
  'salon.messagePlaceholder': 'Message',
  'salon.arreterEnregistrement': 'Stop recording',
  'salon.messageVocal': 'Voice message',
  'salon.appelTitre': 'Call',
  'salon.appelImpossibleDemarrer': "Couldn't start the call for this channel.",
  'salon.retour': 'Back',
  'salon.infosConversation': 'Conversation info',
  'salon.demarrerAppel': 'Start a video call',
  'salon.reponseA': 'Replying to {nom}',
  'salon.annulerReponse': 'Cancel reply',

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

  'accueil.parametres': 'Settings',
  'accueil.sectionNonLus': 'Unread',
  'accueil.sectionSalons': 'Channels',
  'accueil.sectionMessagesPrives': 'Direct messages',
  'accueil.listeVide': 'No channels yet — the first sync may take a few seconds.',
  'accueil.messagesChiffres': 'Encrypted messages',
  'accueil.apercuAppel': 'Video call',
  'accueil.nouvelleConversation': 'New conversation',

  'recherche.titre': 'New conversation',
  'recherche.placeholder': 'User or channel…',
  'recherche.rechercheImpossible': 'Search failed.',
  'recherche.conversationImpossible': "Couldn't start the conversation.",
  'recherche.rejoindreImpossible': "Couldn't join.",
  'recherche.aucunResultat': 'No results.',

  'rechercheMessages.titre': 'Search the channel',
  'rechercheMessages.placeholder': 'Search messages…',
  'rechercheMessages.rechercheImpossible': 'Search failed.',
  'rechercheMessages.aucunMessage': 'No messages found.',

  'fil.titre': 'Thread',
  'fil.introuvable': 'Thread not found.',
  'fil.chiffre': '🔒 End-to-end encrypted channel — writing is not supported by this app.',
  'fil.lectureSeule': 'This channel is read-only.',
  'fil.revenirClavier': 'Back to keyboard',
  'fil.choisirEmoji': 'Choose an emoji',
  'fil.repondre': 'Reply in thread',

  'actionsMessage.messageIntrouvable': 'Message not found.',
  'actionsMessage.aucuneAction': 'Nothing to do with this message.',
  'actionsMessage.chargementImpossible': "Couldn't load.",
  'actionsMessage.actionRefusee': 'Action refused.',
  'actionsMessage.repondre': 'Reply',
  'actionsMessage.modifier': 'Edit',
  'actionsMessage.epingler': 'Pin',

  'joindre.photo': 'Take a photo',
  'joindre.video': 'Record a video',
  'joindre.bibliotheque': 'Choose from library',
  'joindre.fichier': 'Choose a file',

  'partager.titre': 'Share',
  'partager.connecteToi': 'Sign in to share to a conversation.',
  'partager.partageImpossible': "Couldn't share.",
  'partager.ajouterLegende': 'Add a caption…',
  'partager.messageAPartager': 'Message to share',
  'partager.partagerVers': 'Share to',
  'partager.rechercherConversation': 'Search for a conversation…',
  'partager.aucuneConversation': 'No conversations.',
  'partager.chiffre': '🔒 Encrypted',
  'partager.lectureSeule': 'Read-only',
  'partager.retirerPieceJointe': 'Remove attachment',

  'appel.appelVideo': 'Video call',
  'appel.impossibleRejoindre': "Couldn't join the call. It may have ended.",
  'appel.terminerAppel': 'End the call',
  'appel.terminer': 'End',
  'appel.connexion': 'Connecting to the call…',
  'appel.chargementEchoue': "The call couldn't load.",

  'navigateurEmoji.rechercher': 'Search for an emoji',
  'navigateurEmoji.effacerRecherche': 'Clear search',
  'navigateurEmoji.vide': 'No emoji',
  'navigateurEmoji.personnalises': 'Custom',
  'navigateurEmoji.people': 'Smileys & people',
  'navigateurEmoji.nature': 'Animals & nature',
  'navigateurEmoji.food': 'Food & drink',
  'navigateurEmoji.activity': 'Activities',
  'navigateurEmoji.travel': 'Travel & places',
  'navigateurEmoji.objects': 'Objects',
  'navigateurEmoji.symbols': 'Symbols',
  'navigateurEmoji.flags': 'Flags',

  'lecteurAudio.messageVocal': 'Voice message',
  'lecteurAudio.lire': 'Play voice message',
  'lecteurAudio.pause': 'Pause',
  'lecteurVideo.video': 'Video',
  'lecteurVideo.lire': 'Video, tap to play',
  'lecteurVideo.lireAvecTitre': 'Video: {titre}, tap to play',
  'visionneuse.image': 'Image',

  'apercuPieceJointe.image': 'Image',
  'apercuPieceJointe.fichier': 'File',
  'apercuPieceJointe.retirer': 'Remove attachment',
  'apercuPieceJointe.octets': '{taille} B',
  'apercuPieceJointe.kilooctets': '{taille} KB',
  'apercuPieceJointe.megaoctets': '{taille} MB',

  'carteLien.imageAgrandir': 'Image, tap to enlarge',
  'carteLien.lienDefaut': 'Link',
  'carteLien.ouvrir': '{nom}, tap to open',
  'carteEmbed.ouvrir': '{nom}, tap to open',

  'notifications.titreChiffre': 'Encrypted message',
  'notifications.corpsChiffre': 'New message in an encrypted channel.',

  'synchro.baseInutilisable': 'Local database unavailable.',

  'monProfil.titre': 'My profile',
  'monProfil.presenceEnLigne': 'Online',
  'monProfil.presenceAbsent': 'Away',
  'monProfil.presenceOccupe': 'Busy',
  'monProfil.presenceHorsLigne': 'Offline',
  'monProfil.profilIllisible': 'Profile unreadable.',
  'monProfil.selectionImpossible': 'Selection failed.',
  'monProfil.rienAEnregistrer': 'Nothing to save.',
  'monProfil.mdpRequis': 'Your current password is required to change your email or username.',
  'monProfil.profilEnregistre': 'Profile saved ✨',
  'monProfil.codeRefuse': 'Code rejected. Try again.',
  'monProfil.enregistrementImpossible': 'Could not save.',
  'monProfil.preparationCodeImpossible': 'Could not prepare the code.',
  'monProfil.changerPhotoLabel': 'Change profile photo',
  'monProfil.changerPhoto': 'Change photo',
  'monProfil.sectionPresence': 'Presence',
  'monProfil.etiquetteStatut': 'Status text',
  'monProfil.placeholderStatut': 'On vacation ✨',
  'monProfil.sectionProfil': 'Profile',
  'monProfil.etiquetteNom': 'Display name',
  'monProfil.placeholderNom': 'Your name',
  'monProfil.etiquetteBio': 'Bio',
  'monProfil.placeholderBio': 'A few words about you',
  'monProfil.sectionCompte': 'Account',
  'monProfil.aideCompte':
    'Changing your email or username requires your current password — and sometimes a verification code.',
  'monProfil.etiquetteEmail': 'Email address',
  'monProfil.placeholderEmail': 'you@example.com',
  'monProfil.etiquetteUsername': 'Username',
  'monProfil.placeholderUsername': 'username',
  'monProfil.etiquetteMdp': 'Current password',
  'monProfil.verificationRequise': 'Verification required',
  'monProfil.aide2faTotp': 'Enter the code from your authenticator app.',
  'monProfil.aide2faEmail': 'Enter the code that was just sent to you by email.',
  'monProfil.aide2faMdp': 'Re-enter your password to confirm.',
  'monProfil.etiquetteCode': 'Code',
  'monProfil.validerCode': 'Submit code',

  'profil.presenceEnLigne': 'online',
  'profil.presenceAbsent': 'away',
  'profil.presenceOccupe': 'busy',
  'profil.presenceHorsLigne': 'offline',
  'profil.profilIllisible': 'Profile unreadable.',
  'profil.profilIntrouvable': 'Profile not found.',
  'profil.conversationImpossible': 'Conversation failed.',
  'profil.actionImpossible': 'Action failed.',
  'profil.heureLocale': 'Local time: {heure}',
  'profil.envoyerMessageLabel': 'Send a message to {nom}',
  'profil.boutonMessage': '💬 Message',
  'profil.appelerLabel': 'Call {nom}',
  'profil.boutonAppeler': '📞 Call',

  'salonInfo.typeCanalPublic': 'Public channel',
  'salonInfo.typeGroupePrive': 'Private group',
  'salonInfo.typeMessageDirect': 'Direct message',
  'salonInfo.membres': '{n} member | {n} members',
  'salonInfo.chiffre': 'encrypted',
  'salonInfo.lectureSeule': 'read-only',
  'salonInfo.detailsIndisponibles': 'Details unavailable.',
  'salonInfo.annonce': 'Announcement',
  'salonInfo.sujet': 'Topic',
  'salonInfo.description': 'Description',
  'salonInfo.rienARenseigner': 'No description, topic, or announcement.',
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
