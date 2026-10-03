# Journal des modifications

Les changements notables de l'app mobile. Format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon le [versionnage sémantique](https://semver.org/lang/fr/). La version vit dans
`app.json` (avec `package.json` et `android.versionCode`) ; un tag `mobile-vX.Y.Z` publie la
release, et ses notes sont la section de la version ici.

## [Non publié]

### Salons RocketVibe

- Recherche dans les messages du salon via le fournisseur natif, dans l'écran
  existant. Résultats temporaires, droits vérifiés et relance avec Entrée ;
  la recherche Rocket.Chat passe par son propre fournisseur.

- Présence dans les DM et saisie dans les composeurs existants, avec expiration
  après une coupure et arrêt à la suspension. Les mentions @here ciblent les
  membres présents au moment de l'envoi.

- Fils natifs dans l'écran existant : compteur de réponses, citations dans un
  fil, brouillon séparé et réponse durable après une coupure. Lire un fil laisse
  les autres non lus ; supprimer sa racine conserve le brouillon et bloque
  les nouvelles réponses.
- Citations natives imbriquées sur deux niveaux dans les cartes existantes.
  Chaque source garde ses droits ; le retrait d'une source enfant efface son
  texte privé sans masquer le parent encore accessible, même après redémarrage.
- Créations, membres et changements de réglages affichés dans les lignes
  système existantes, en français ou anglais, sans créer de non-lus ni proposer
  d'actions de message sur ces événements.
- Citations natives dans l'action Répondre, le bandeau et le composeur existants,
  y compris sans texte ajouté. Les références sont transmises à la file durable ;
  une sélection refusée conserve les mots saisis. Une source indisponible porte
  un libellé explicite et son aperçu privé est effacé.

- Une édition devenue obsolète conserve les mots saisis et signale un conflit,
  même si le cache a déjà reçu la nouvelle version du message.

- L'édition d'une réponse native conserve ses références de citation, même après
  suppression de la source ou perte de son accès. L'intention sauvegardée garde
  le même contenu après coupure et redémarrage. Une ancienne édition sans contenu
  capturé conserve son brouillon et demande une nouvelle soumission.

- Les citations natives alimentent les cartes actuelles depuis un cache séparant
  références et extraits autorisés. Éditions, suppressions et retraits d'accès à
  la source actualisent les citations dans les autres salons ; les anciennes
  réponses ne rétablissent pas un extrait supprimé. Migration SQLite additive et
  texte natif conservé, même s'il ressemble à un ancien préfixe Rocket.Chat.

- Les messages natifs confirmés sont traduits vers les composants de rendu
  existants depuis un document typé commun avec le bureau. Les conventions de
  gras, italique et barré du composeur sont conservées. Code, citations, labels
  de liens et mentions échappées ne deviennent pas des mentions actives ; les
  images Markdown restent littérales en attendant les fichiers natifs.

- Badges de non-lus et mentions confirmés, et barre existante des nouveaux
  messages avec la position capturée à l'ouverture. Les minuteries retiennent
  un message confirmé réellement visible dans FlashList et l'adhésion ouverte,
  sans prendre le dernier message du cache. Une rafale ne repousse pas le timer ;
  retour à l'arrière-plan et fermeture sauvent les observations déjà vues. Les
  badges restent confirmés hors ligne et la barre reste après acquittement.

- Favoris dans la fiche existante : seule la préférence confirmée change le
  classement du salon. Une demande en attente affiche Reprendre ; un refus
  permet un effacement explicite. Un ancien clic ne remplace pas une préférence
  récente et ne traverse pas un changement d'adhésion. Rocket.Chat conserve son
  action officielle via le fournisseur actif.

- Les composeurs et formulaires ouverts repartent à vide lors d'une nouvelle
  adhésion. Les sauvegardes et envois tardifs de l'ancien composeur ne peuvent
  écraser un nouveau brouillon ni remettre l'ancien texte en attente. Un
  changement de rôle conserve le brouillon courant.

- Lectures et favoris natifs possèdent maintenant une reprise SQLite après
  interruption : message observé conservé, reçu de favori original récupéré,
  sans rétablir une ancienne préférence. Un callback de lecture tardif ne peut
  traverser un retrait suivi d'une réadhésion.

- Le cache détecte un retrait suivi d'une réadhésion même après un événement
  manqué et un nouveau snapshot : historique privé, brouillons et intentions
  antérieurs sont purgés. Un changement de rôle conserve les intentions de
  l'adhésion actuelle. Le premier témoin d'adhésion purge également les
  intentions des anciens caches qui n'en possédaient pas.
- Le composeur suit les droits effectifs après changement de réglages ou de
  rôle : propriétaires et modérateurs peuvent écrire en lecture seule, les
  membres voient le message existant. Une ancienne réponse ne rétablit aucun
  droit après retrait ou nouvelle version du salon.

- Réglages, liste paginée des membres, rôles et départ dans la fiche existante,
  selon les droits actuels. Les commandes interrompues reprennent leur reçu
  original ; un formulaire refusé reste conservé jusqu'à relecture ou effacement
  explicite. Le dernier propriétaire doit transmettre le rôle avant de partir.

- La fiche existante affiche le sujet, la description, l'annonce, le nombre de
  membres et la lecture seule depuis le fournisseur actif. Elle se rafraîchit
  après modification et masque ses données après retrait du salon. Les textes
  longs défilent dans la feuille.

### Sécurité RocketVibe

- Demande d’un code de récupération du mot de passe par e-mail dans le
  formulaire existant, avec lecture locale de SecureStore, reprise de la demande
  originale et délai de retry conservé. L’effacement du formulaire est explicite ;
  la connexion après réinitialisation conserve les facteurs installés.

- Activation et retrait explicites des codes par e-mail dans les paramètres
  existants, avec confirmation liée au contact et aux facteurs affichés, reprise
  du reçu depuis SecureStore et présentation des secours communs. Un autre
  facteur installé est conservé ; l’adresse doit être libérée de ce profil avant
  remplacement ou retrait.

- Un profil protégé uniquement par e-mail est affiché comme actif et peut
  régénérer ses codes de secours communs sans SMTP. Demander ou reprendre un
  code de confirmation d’identité efface la saisie précédente.
- Codes de connexion et de confirmation d’identité par e-mail dans les écrans
  existants, avec livraison explicite et reprise du même candidat depuis
  SecureStore après une réponse perdue. Les renvois gardent le même code et
  son échéance ; le code saisi reste uniquement en mémoire.
- Retrait du contact e-mail après confirmation, avec reprise de l’intention
  originale depuis SecureStore et reçu privé jusqu’à Terminer. Une annulation
  retardée préserve le contact suivant ; le parcours reste disponible sans SMTP.
- Une adresse refusée peut être fermée explicitement avant une nouvelle saisie,
  sans bloquer le formulaire ni effacer le contact déjà vérifié.
- Adresse e-mail privée dans les paramètres existants : code de vérification,
  état de livraison et reprise depuis SecureStore après une coupure. Le code
  saisi reste transitoire et une ancienne vérification ne remplace pas la suivante.
- Configuration TOTP, codes de secours privés, remplacement et désactivation
  dans les paramètres existants. Les opérations interrompues reprennent depuis
  SecureStore et les codes restent récupérables jusqu’à leur confirmation.
- Confirmation d’identité sur l’appareil courant avant une action sensible,
  sans nouvelle session. Les mots de passe et codes saisis restent transitoires ;
  les callbacks d’un ancien écran ou compte ne peuvent lancer une action.

### Ajouté

- Double authentification RocketVibe dans le formulaire existant : application
  TOTP ou code de secours. Une validation interrompue se reprend depuis le
  stockage sécurisé sans consommer un deuxième code ni modifier un autre compte.

- Récupération du mot de passe RocketVibe par code opérateur dans la connexion
  existante : identité et conversations conservées, anciennes sessions révoquées
  et confirmation perdue reprenable. Les clés de chiffrement sont préservées.

- Création d'un compte RocketVibe sur invitation dans l'écran de connexion existant.
  La reprise après réponse perdue conserve le même compte ; le parcours vérifie
  l'identité et la génération du serveur avant de sauvegarder la session.

- Appareils RocketVibe connectés dans les paramètres existants : noms, dates
  d’activité / expiration et révocation après connexion récente. Les alertes
  conservées d’un ancien compte ne peuvent agir sur le nouveau.

- Renouvellement des sessions RocketVibe avant expiration via SecureStore.
  L'intention sauvegardée reprend après une réponse perdue ; la reconnexion
  conserve les brouillons et l'outbox du compte.

- Épingles publiques et étoiles personnelles RocketVibe dans les actions et
  listes existantes. Les intentions reprennent après redémarrage ; les étoiles
  restent privées et conservent leur état lors des mises à jour du message.

- Réactions RocketVibe dans la feuille d'actions et les pastilles existantes.
  Les alias d'emojis sont dédupliqués ; les intentions SQLite reprennent après
  une réponse perdue ou un redémarrage sans modifier l'ordre des messages.

- Édition et suppression RocketVibe dans la feuille d'actions existante, selon les
  droits du serveur. Les intentions et révisions sont conservées dans SQLite,
  reprises après coupure ; le texte d'une édition refusée reste récupérable à
  la réouverture. Un conflit concurrent s'affiche sans écraser le nouveau texte.

- Projection des éditions et suppressions RocketVibe dans les écrans existants :
  marqueur d'édition, effacement local et révisions empêchant un historique tardif
  de rétablir le texte. Un reset remplace l'historique confirmé tout en conservant
  brouillons et file d'envoi des salons encore accessibles.

- Reprise des envois RocketVibe après panne temporaire ou réponse perdue, même
  lorsque la socket reste connectée. Les retries conservent l'identité SQLite,
  respectent `Retry-After` et s'arrêtent en suspension / déconnexion du compte.

- Recherche et adhésion aux salons publics RocketVibe dans l'écran existant.
  Une création interrompue conserve son identité dans SQLite pour être retentée
  après reconnexion ou redémarrage sans créer un second salon.

- Reprise automatique des envois RocketVibe après revalidation des droits,
  sans marquer l'intention persistante comme définitivement refusée.

- Snapshots RocketVibe paginés et immuables, téléchargés puis validés avant
  remplacement atomique du cache ; pages expirées ou retirées rejetées sans
  appliquer de vue partielle. Compatibilité conservée avec les anciens serveurs natifs.

- Capacités RocketVibe vérifiées à chaque reconnexion et limitées aux fonctions
  prises en charge par l'app ; diagnostics fournisseur avec identifiant de requête.

- Respect du délai serveur après un refus `429` RocketVibe, sans perte du compte
  ni relance prématurée de la connexion ; reprise testée après expiration réelle
  du curseur, avec brouillon et envoi hors ligne conservés.

- Connexion aux serveurs Rocket.Chat et RocketVibe dans les mêmes écrans :
  liste des salons, recherche de correspondants / DM, Markdown, texte, historique
  et brouillons persistants. Les sessions
  restent dans le Keystore ; SQLite conserve messages, curseurs et file d'envoi.
- Reprise du journal après coupure, rejeu des envois avec le même identifiant et
  purge locale au retrait d'un salon. Un changement d'identité / génération du
  serveur demande une nouvelle connexion.

Les comptes des deux fournisseurs cohabitent dans le sélecteur existant. Les
capacités natives non implémentées (fils, fichiers, réactions, non-lus, push,
appels et E2EE) sont désactivées ; Rocket.Chat conserve ses fonctionnalités.

## [0.4.0] - 2026-09-30

### Ajouté

- Une section Favoris dans la liste des salons, après Non lus, pour les salons mis en favori
  sur le serveur (comme dans le client officiel) ; la fiche d'un salon l'y ajoute ou l'en
  retire.

### Corrigé

- L'aperçu du dernier message dans la liste des salons montrait la syntaxe markdown
  (délimiteurs de code, étoiles, crochets des liens) : il se lit désormais comme du texte.

## [0.3.1] - 2026-09-29

### Corrigé

- Les pièces jointes préparées dans un salon, pas encore envoyées, étaient perdues en
  changeant de salon : elles attendent désormais qu'on y revienne.

## [0.3.0] - 2026-09-29

### Ajouté

- Salon chiffré : une fois déverrouillé, on y écrit comme ailleurs. Le message part chiffré
  (les mentions notifient toujours) ; verrouillé, il attend le déverrouillage au lieu d'échouer.
  On peut aussi y modifier ses messages et répondre dans un fil.
- Salon chiffré : les photos, sons et vidéos envoyés chiffrés s'affichent (déchiffrés sur
  l'appareil, jusqu'à 25 Mo), et tout fichier chiffré se partage ou s'enregistre en clair.
  On y joint aussi des fichiers : ils partent chiffrés, nom et légende compris.

### Corrigé

- Un salon chiffré créé par un ancien client web (clé de salon AES-128) se lit de nouveau une
  fois déverrouillé, au lieu de n’afficher que des messages « chiffrés, non pris en charge ».

## [0.2.0] - 2026-09-29

### Ajouté

- Liste des salons : un appui sur le titre d'une section (Non lus, Salons, Messages privés) la
  replie ou la déplie ; repliée, elle affiche son nombre de conversations, et l'état est retenu
  d'un lancement à l'autre.
- Salon : remonté de plus d'un écran dans l'historique, un bouton rond en bas à droite ramène
  d'un geste aux derniers messages.
- Messages : épingler et désépingler, ajouter aux favoris et en retirer, depuis les actions
  d'un message. Un bouton 📌 dans l'en-tête du salon ouvre ses messages épinglés et vos
  favoris ; toucher l'un d'eux ramène la conversation jusqu'à lui et le surligne, en chargeant
  l'historique plus ancien au besoin.
- Composer : les pièces jointes attendent l'envoi en pastilles (vignette ou icône, nom, format et
  poids, ✕ pour retirer) ; on peut en joindre plusieurs à la fois, les prévisualiser d'un toucher,
  et le texte tapé part en légende de la première.

### Modifié

- Un fichier refusé par le serveur (taille, type) l'est dès qu'on le joint, et non plus au
  moment d'envoyer.

### Corrigé

- Les actions d’un message suivent vos droits réels sur le serveur : plus d’« Épingler » sans
  la permission, et un modérateur peut modifier ou supprimer les messages des autres.
- Un fichier envoyé garde son nom d’origine ; une copie faite par le sélecteur partait sous un
  nom de cache aléatoire.
- Un partage vers l’app alors qu’elle n’était pas lancée ouvre bien l’écran de partage, du
  premier coup ; et un partage n’est plus rejoué à chaque ouverture suivante de l’app.

## [0.1.0] - 2026-09-27

Première version publiée : Android, pour Rocket.Chat 8 ou plus récent.

### Ajouté

- Connexion par mot de passe avec double authentification (TOTP, e-mail, mot de passe),
  session gardée dans le stockage sécurisé.
- Hors-ligne d'abord : une base SQLite par serveur et par compte, que l'interface observe ;
  REST pour agir, DDP pour écouter, reconnexion et rattrapage automatiques.
- Liste des salons par activité, en sections (non lus, salons, messages privés), avec
  présence, aperçus, badges de non-lus et recherche de personnes et de salons.
- Fil de messages : markdown natif, emojis (dont personnalisés), mentions, citations,
  fils de discussion, réactions, épinglage, édition et suppression, brouillons par salon.
- Envoi de fichiers en deux temps (photos, vidéos réduites, documents, messages vocaux),
  avec progression, reprise et abandon.
- Lecture audio et vidéo intégrée, aperçus de liens et cartes YouTube / Dailymotion / Vimeo.
- Indicateur de saisie, barre « nouveaux messages », recherche dans un salon.
- Notifications push FCM au contenu masqué, récupéré à la réception ; réponse depuis la
  notification ; ouverture du salon par lien `rocketvibe://`.
- Lecture des salons chiffrés de bout en bout après déverrouillage.
- Appels vidéo Jitsi.
- Partage depuis d'autres apps vers un salon.
- Profils, informations de salon, mon profil (statut, photo, informations).
- Interface en français et en anglais.

[Non publié]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.4.0...HEAD
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.1...mobile-v0.4.0
[0.3.1]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.0...mobile-v0.3.1
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.2.0...mobile-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.1.0...mobile-v0.2.0
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/mobile-v0.1.0
