# Journal des modifications

Les changements notables de l'app mobile. Format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon le [versionnage sémantique](https://semver.org/lang/fr/). La version vit dans
`app.json` (avec `package.json` et `android.versionCode`) ; un tag `mobile-vX.Y.Z` publie la
release, et ses notes sont la section de la version ici.

## [Non publié]

### Sécurité RocketVibe

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
